import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient } from 'pg'

import { buildApp } from '../../src/app.js'
import { Ed25519TokenService } from '../../src/auth/token-service.js'
import { WechatStubGateway } from '../../src/auth/wechat-stub-gateway.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { systemClock } from '../../src/lib/clock.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import { Metrics } from '../../src/observability/metrics.js'
import { Finalizer } from '../../src/uploads/finalizer.js'
import {
  createR2S3Client,
  R2ObjectStorage,
  type R2ObjectStorageConfig,
} from '../../src/uploads/r2-object-storage.js'
import { LocalUploadSpool, QueuedR2ObjectStorage } from '../../src/uploads/queued-object-storage.js'
import { PostgresUploadConcurrency } from '../../src/uploads/upload-concurrency.js'
import { loadDestructiveDatabaseTestConfig } from './destructive-database.js'

const LOCAL_E2E_LOCK = '9062471520260715'
const TRUNCATE_TEST_DATA = `truncate table
  media_app.audit_events,
  media_app.idempotency_records,
  media_app.upload_parts,
  media_app.upload_sessions,
  media_app.media_objects,
  media_app.user_sessions,
  media_app.user_identities,
  media_app.users restart identity cascade`

export interface LocalPrivateUploadHarness {
  readonly app: FastifyInstance
  readonly origin: string
  readonly migrationPool: Pool
  readonly runtimePool: Pool
  readonly r2Config: R2ObjectStorageConfig
  readonly finalizer: Finalizer
  close(): Promise<void>
}

export interface LocalPrivateUploadHarnessOptions {
  readonly label?: string
}

interface StoredObjectRow {
  r2_bucket: string
  object_key: string
  r2_upload_id: string
}

function localEndpoint(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Local MinIO endpoint is invalid')
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error('Local MinIO endpoint must use a loopback host')
  }
  return parsed.origin
}

function localR2Config(): R2ObjectStorageConfig {
  return {
    endpoint: localEndpoint(process.env['MINIO_ENDPOINT'] ?? 'http://127.0.0.1:59000'),
    bucket: process.env['MINIO_BUCKET'] ?? 'wx-private-media',
    accessKeyId: process.env['MINIO_ACCESS_KEY_ID'] ?? 'minio_local',
    secretAccessKey: process.env['MINIO_SECRET_ACCESS_KEY'] ?? 'minio_local_secret',
    forcePathStyle: true,
  }
}

async function releaseLock(client: PoolClient | undefined): Promise<void> {
  if (client === undefined) return
  await client
    .query('select pg_advisory_unlock($1::bigint)', [LOCAL_E2E_LOCK])
    .catch(() => undefined)
  client.release()
}

async function closePools(pools: readonly (Pool | undefined)[]): Promise<void> {
  await Promise.all(
    pools
      .filter((pool): pool is Pool => pool !== undefined)
      .map((pool) => pool.end().catch(() => undefined)),
  )
}

export async function startLocalPrivateUploadHarness(
  options: LocalPrivateUploadHarnessOptions = {},
): Promise<LocalPrivateUploadHarness> {
  const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
  const r2Config = localR2Config()
  const label = options.label ?? 'local-e2e'
  let migrationPool: Pool | undefined
  let runtimePool: Pool | undefined
  let lockClient: PoolClient | undefined
  let app: FastifyInstance | undefined
  let spoolDirectory: string | undefined
  const cleanupClient = createR2S3Client(r2Config)

  try {
    migrationPool = createPool(databaseConfig.migrationDatabaseUrl, undefined, {
      max: 4,
      applicationName: `wx-${label}-migration`.slice(0, 63),
    })
    lockClient = await migrationPool.connect()
    await lockClient.query('select pg_advisory_lock($1::bigint)', [LOCAL_E2E_LOCK])
    await runMigrations(migrationPool, new URL('../../src/db/migrations', import.meta.url).pathname)
    await applyRoleGrants(migrationPool, {
      runtimeRole: 'wx_runtime',
      maintenanceRole: 'wx_maintenance',
    })
    await migrationPool.query(TRUNCATE_TEST_DATA)

    runtimePool = createPool(databaseConfig.runtimeDatabaseUrl, undefined, {
      max: 12,
      applicationName: `wx-${label}-runtime`.slice(0, 63),
    })
    const remoteStorage = new R2ObjectStorage(r2Config)
    if (!(await remoteStorage.ready())) throw new Error('Local MinIO test bucket is not ready')
    spoolDirectory = await mkdtemp(join(tmpdir(), 'wx-upload-e2e-spool-'))
    const uploadSpool = new LocalUploadSpool({ rootDirectory: spoolDirectory })
    const queuedStorage = new QueuedR2ObjectStorage({
      spool: uploadSpool,
      remote: remoteStorage,
    })

    const ids = createSecureIdGenerator(systemClock)
    const pair = generateKeyPairSync('ed25519')
    const tokenService = new Ed25519TokenService({
      privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      clock: systemClock,
      ids,
    })
    const metrics = new Metrics()
    const concurrency = new PostgresUploadConcurrency({ pool: runtimePool })
    app = buildApp({
      admin: {
        username: 'test-admin',
        passwordVerifier: `scrypt:16384:8:1:${Buffer.alloc(16, 0x41).toString('base64url')}:${Buffer.alloc(32, 0x42).toString('base64url')}`,
        sessionSecret: Buffer.alloc(32, 0x43),
      },
      pool: runtimePool,
      readiness: {
        database: async (signal) => {
          if (signal.aborted) return false
          await runtimePool?.query('select 1')
          return !signal.aborted
        },
        objectStorage: (signal) => uploadSpool.ready(signal),
      },
      clock: systemClock,
      ids,
      logger: false,
      metrics,
      monitoringToken: 'local-e2e-monitoring-token',
      trustProxy: false,
      wechatAppId: 'wx-local-e2e-app',
      wechatGateway: new WechatStubGateway(),
      tokenService,
      objectStorage: uploadSpool,
      objectStorageBucket: r2Config.bucket,
      cursorSigningSecret: Buffer.alloc(32, 0x5a),
      uploadConcurrency: concurrency,
    })
    const finalizer = new Finalizer({
      pool: runtimePool,
      storage: queuedStorage,
      concurrency,
      clock: systemClock,
      ids,
      alerts: metrics,
    })
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const runningApp = app
    const runningMigrationPool = migrationPool
    const runningRuntimePool = runtimePool
    const runningLockClient = lockClient
    const runningSpoolDirectory = spoolDirectory
    let closed = false

    return {
      app: runningApp,
      origin,
      migrationPool: runningMigrationPool,
      runtimePool: runningRuntimePool,
      r2Config,
      finalizer,
      async close() {
        if (closed) return
        closed = true
        let cleanupFailed = false
        try {
          await runningApp.close()
        } catch {
          cleanupFailed = true
        }

        let storedRows: StoredObjectRow[] = []
        try {
          const stored = await runningMigrationPool.query<StoredObjectRow>(
            `select distinct m.r2_bucket, m.object_key, u.r2_upload_id
               from media_app.media_objects m
               join media_app.upload_sessions u on u.media_object_id = m.id`,
          )
          storedRows = stored.rows
        } catch {
          cleanupFailed = true
        }
        for (const row of storedRows) {
          const remoteState = await uploadSpool.remoteState(row.r2_upload_id).catch(() => undefined)
          if (remoteState !== undefined) {
            await remoteStorage
              .abortMultipart({
                bucket: row.r2_bucket,
                key: row.object_key,
                uploadId: remoteState.uploadId,
              })
              .catch(() => undefined)
          }
          try {
            await cleanupClient.send(
              new DeleteObjectCommand({ Bucket: row.r2_bucket, Key: row.object_key }),
            )
          } catch {
            cleanupFailed = true
          }
        }
        await rm(runningSpoolDirectory, { recursive: true, force: true }).catch(() => {
          cleanupFailed = true
        })
        try {
          await runningMigrationPool.query(TRUNCATE_TEST_DATA)
        } catch {
          cleanupFailed = true
        }
        cleanupClient.destroy()
        await releaseLock(runningLockClient)
        await closePools([runningRuntimePool, runningMigrationPool])
        if (cleanupFailed) throw new Error('Local E2E cleanup failed')
      },
    }
  } catch (error) {
    await app?.close().catch(() => undefined)
    cleanupClient.destroy()
    if (spoolDirectory !== undefined) {
      await rm(spoolDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    await releaseLock(lockClient)
    await closePools([runtimePool, migrationPool])
    throw error
  }
}
