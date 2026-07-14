import { generateKeyPairSync } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { buildApp } from './app.js'
import { Ed25519TokenService } from './auth/token-service.js'
import type { WechatGateway } from './auth/wechat-gateway.js'
import { WechatHttpGateway } from './auth/wechat-http-gateway.js'
import { WechatStubGateway } from './auth/wechat-stub-gateway.js'
import { loadRuntimeConfig, type Environment, type RuntimeConfig } from './config.js'
import { createPool } from './db/pool.js'
import { systemClock } from './lib/clock.js'
import { createSecureIdGenerator, type IdGenerator } from './lib/id.js'
import { createProductionLogger } from './observability/logger.js'
import { Metrics } from './observability/metrics.js'
import { R2ObjectStorage } from './uploads/r2-object-storage.js'

export interface DatabaseReadinessClient {
  query(text: string): Promise<unknown>
  release(destroy?: boolean): void
}

export interface DatabaseReadinessPool {
  connect(): Promise<DatabaseReadinessClient>
}

interface ServerApp {
  listen(options: { host: string; port: number }): Promise<unknown>
  close(): Promise<void>
}

interface ServerPool {
  end(): Promise<void>
}

interface PreparedServerRuntime {
  app: ServerApp
  pool: ServerPool
}

async function acquireReadinessClient(
  pool: DatabaseReadinessPool,
  signal: AbortSignal,
): Promise<DatabaseReadinessClient | undefined> {
  if (signal.aborted) return undefined
  const pendingClient = pool.connect()
  return new Promise((resolve) => {
    let settled = false
    const finish = (client: DatabaseReadinessClient | undefined): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      resolve(client)
    }
    const aborted = () => {
      finish(undefined)
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    void pendingClient.then(
      (client) => {
        if (settled || signal.aborted) {
          try {
            client.release(true)
          } catch {
            // The connection is already unusable; readiness remains false.
          }
          finish(undefined)
          return
        }
        finish(client)
      },
      () => {
        finish(undefined)
      },
    )
  })
}

export async function databaseIsReady(
  pool: DatabaseReadinessPool,
  signal: AbortSignal,
): Promise<boolean> {
  const client = await acquireReadinessClient(pool, signal)
  if (client === undefined) return false

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ready: boolean, destroy: boolean): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      try {
        if (destroy) client.release(true)
        else client.release()
      } catch {
        // A release failure cannot make a readiness probe successful.
        ready = false
      }
      resolve(ready)
    }
    const aborted = () => {
      finish(false, true)
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {
      aborted()
      return
    }
    void client.query('select 1').then(
      () => {
        finish(!signal.aborted, signal.aborted)
      },
      () => {
        finish(false, true)
      },
    )
  })
}

function configuredSecrets(config: RuntimeConfig): string[] {
  return [
    config.databaseUrl,
    config.wechat.appSecret,
    config.jwt.privateKey,
    config.jwt.publicKey,
    config.r2.accessKeyId,
    config.r2.secretAccessKey,
    config.server.monitoringToken,
  ].filter((value) => value !== '')
}

export function createConfiguredWechatGateway(config: RuntimeConfig['wechat']): WechatGateway {
  if (config.authMode === 'stub') return new WechatStubGateway()
  return new WechatHttpGateway({
    appId: config.appId,
    appSecret: config.appSecret,
    endpoint: config.endpoint,
    connectTimeoutMs: config.connectTimeoutMs,
    totalTimeoutMs: config.totalTimeoutMs,
  })
}

function developmentSigningKeys(config: RuntimeConfig): {
  privateKey: string
  publicKey: string
} {
  const temporary = 'temporary-development-key'
  const mayGenerate = config.nodeEnv !== 'production'
  const privateIsTemporary = config.jwt.privateKey === '' || config.jwt.privateKey === temporary
  const publicIsTemporary = config.jwt.publicKey === '' || config.jwt.publicKey === temporary
  if (mayGenerate && privateIsTemporary && publicIsTemporary) {
    const pair = generateKeyPairSync('ed25519')
    return {
      privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    }
  }
  return { privateKey: config.jwt.privateKey, publicKey: config.jwt.publicKey }
}

export function createConfiguredTokenService(config: RuntimeConfig, ids: IdGenerator) {
  const keys = developmentSigningKeys(config)
  return new Ed25519TokenService({
    ...keys,
    clock: systemClock,
    ids,
  })
}

export function createServerRuntime(config: RuntimeConfig) {
  const logger = createProductionLogger({
    environment: config.nodeEnv,
    service: 'wx-upload-api',
    secrets: configuredSecrets(config),
  })
  const pool = createPool(config.databaseUrl, (error) => {
    logger.error({ err: error, errorCode: 'POSTGRES_IDLE_CLIENT_ERROR' }, 'database pool error')
  })
  const ids = createSecureIdGenerator(systemClock)
  const objectStorage = new R2ObjectStorage(config.r2)
  const app = buildApp({
    pool,
    readiness: {
      database: (signal) => databaseIsReady(pool, signal),
      objectStorage: (signal) => objectStorage.ready(signal),
    },
    clock: systemClock,
    ids,
    logger,
    metrics: new Metrics(),
    monitoringToken: config.server.monitoringToken,
    trustProxy: config.server.trustProxy,
    wechatAppId: config.wechat.appId,
    wechatGateway: createConfiguredWechatGateway(config.wechat),
    tokenService: createConfiguredTokenService(config, ids),
    objectStorage,
    objectStorageBucket: config.r2.bucket,
  })
  return { app, pool }
}

export function createResourceCloser(app: Pick<ServerApp, 'close'>, pool: ServerPool) {
  let closing: Promise<void> | undefined
  return (): Promise<void> => {
    closing ??= (async () => {
      const failures: unknown[] = []
      try {
        await app.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        await pool.end()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Server resource cleanup failed')
    })()
    return closing
  }
}

function installShutdownHandlers(closeResources: () => Promise<void>): () => void {
  const shutdown = () => {
    void closeResources().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return () => {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
  }
}

export async function startPreparedServer(
  server: Pick<RuntimeConfig['server'], 'host' | 'port'>,
  runtime: PreparedServerRuntime,
): Promise<{ close(): Promise<void> }> {
  const closeResources = createResourceCloser(runtime.app, runtime.pool)
  const removeShutdownHandlers = installShutdownHandlers(closeResources)
  try {
    await runtime.app.listen({ host: server.host, port: server.port })
  } catch (error) {
    removeShutdownHandlers()
    await closeResources().catch(() => undefined)
    throw error
  }
  return {
    async close() {
      removeShutdownHandlers()
      await closeResources()
    },
  }
}

export async function startServer(env: Environment = process.env): Promise<{
  close(): Promise<void>
}> {
  const config = loadRuntimeConfig(env)
  return startPreparedServer(config.server, createServerRuntime(config))
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url) {
  void startServer().catch(() => {
    process.stderr.write('API failed to start\n')
    process.exitCode = 1
  })
}
