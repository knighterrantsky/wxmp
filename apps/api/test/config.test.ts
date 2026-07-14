import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadMaintenanceConfig, loadMigrationConfig, loadRuntimeConfig } from '../src/config.js'

const databaseUrl = 'postgresql://runtime:runtime-password@db.internal/wx_upload'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const mismatchedPublicKey = generateKeyPairSync('ed25519').publicKey

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: databaseUrl,
  WECHAT_AUTH_MODE: 'real',
  WECHAT_APP_ID: 'wx1234567890abcdef',
  WECHAT_APP_SECRET: 'wechat-secret-value-for-production',
  WECHAT_CODE2SESSION_ENDPOINT: 'https://api.weixin.qq.com/sns/jscode2session',
  JWT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  JWT_PUBLIC_KEY: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  R2_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
  R2_BUCKET: 'private-media-production',
  R2_ACCESS_KEY_ID: 'r2-production-access-key-id',
  R2_SECRET_ACCESS_KEY: 'r2-production-secret-access-key-value',
  R2_FORCE_PATH_STYLE: 'false',
  HOST: '127.0.0.1',
  PORT: '3000',
  MONITORING_TOKEN: 'production-monitor-token-at-least-32-characters',
  TRUST_PROXY: '1',
} satisfies Record<string, string>

const developmentStubEnv = {
  ...productionEnv,
  NODE_ENV: 'development',
  WECHAT_AUTH_MODE: 'stub',
  WECHAT_APP_ID: 'example-app-id',
  WECHAT_APP_SECRET: 'example-app-secret',
  JWT_PRIVATE_KEY: 'temporary-development-key',
  JWT_PUBLIC_KEY: 'temporary-development-key',
  R2_ENDPOINT: 'http://127.0.0.1:59000',
  R2_ACCESS_KEY_ID: 'minio_local',
  R2_SECRET_ACCESS_KEY: 'minio_local_secret',
  R2_FORCE_PATH_STYLE: 'true',
} satisfies Record<string, string>

describe('configuration privilege separation', () => {
  it('loads the runtime using only DATABASE_URL in test mode', () => {
    const forbidden = new Set(['MIGRATION_DATABASE_URL', 'MAINTENANCE_DATABASE_URL'])
    const env = new Proxy<Record<string, string | undefined>>(
      { NODE_ENV: 'test', DATABASE_URL: databaseUrl },
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && forbidden.has(property)) {
            throw new Error(`runtime read forbidden key ${property}`)
          }
          return Reflect.get(target, property, receiver) as string | undefined
        },
      },
    )

    const config = loadRuntimeConfig(env)

    expect(config.databaseUrl).toBe(databaseUrl)
    expect(config).not.toHaveProperty('migrationDatabaseUrl')
    expect(config).not.toHaveProperty('maintenanceDatabaseUrl')
  })

  it('loads migrations using only MIGRATION_DATABASE_URL and validated role names', () => {
    expect(
      loadMigrationConfig({
        MIGRATION_DATABASE_URL: 'postgresql://migrate:password@db.internal/wx_upload',
        DATABASE_RUNTIME_ROLE: 'wx_runtime',
        DATABASE_MAINTENANCE_ROLE: 'wx_maintenance',
      }),
    ).toEqual({
      databaseUrl: 'postgresql://migrate:password@db.internal/wx_upload',
      runtimeRole: 'wx_runtime',
      maintenanceRole: 'wx_maintenance',
    })
    expect(() =>
      loadMigrationConfig({
        DATABASE_URL: databaseUrl,
        DATABASE_RUNTIME_ROLE: 'wx_runtime',
        DATABASE_MAINTENANCE_ROLE: 'wx_maintenance',
      }),
    ).toThrow(/MIGRATION_DATABASE_URL/)
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL: databaseUrl,
        DATABASE_RUNTIME_ROLE: 'wx_runtime; drop role postgres',
        DATABASE_MAINTENANCE_ROLE: 'wx_maintenance',
      }),
    ).toThrow(/DATABASE_RUNTIME_ROLE/)
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL: databaseUrl,
        DATABASE_RUNTIME_ROLE: 'same_role',
        DATABASE_MAINTENANCE_ROLE: 'same_role',
      }),
    ).toThrow(/roles/i)
  })

  it.each(['PUBLIC', 'postgres', 'pg_read_all_data', 'PG_custom_role'])(
    'rejects the dangerous database role name %s',
    (role) => {
      expect(() =>
        loadMigrationConfig({
          MIGRATION_DATABASE_URL: databaseUrl,
          DATABASE_RUNTIME_ROLE: role,
          DATABASE_MAINTENANCE_ROLE: 'wx_maintenance',
        }),
      ).toThrow(/DATABASE_RUNTIME_ROLE/)
      expect(() =>
        loadMigrationConfig({
          MIGRATION_DATABASE_URL: databaseUrl,
          DATABASE_RUNTIME_ROLE: 'wx_runtime',
          DATABASE_MAINTENANCE_ROLE: role,
        }),
      ).toThrow(/DATABASE_MAINTENANCE_ROLE/)
    },
  )

  it('loads maintenance using only MAINTENANCE_DATABASE_URL', () => {
    expect(
      loadMaintenanceConfig({
        MAINTENANCE_DATABASE_URL: 'postgresql://maintenance:password@db.internal/wx_upload',
      }),
    ).toEqual({
      databaseUrl: 'postgresql://maintenance:password@db.internal/wx_upload',
    })
    expect(() => loadMaintenanceConfig({ DATABASE_URL: databaseUrl })).toThrow(
      /MAINTENANCE_DATABASE_URL/,
    )
  })
})

describe('runtime production safety', () => {
  it('accepts complete production configuration and fixes WeChat timeouts', () => {
    const config = loadRuntimeConfig({
      ...productionEnv,
      WECHAT_CONNECT_TIMEOUT_MS: '99999',
      WECHAT_TOTAL_TIMEOUT_MS: '99999',
    })

    expect(config.nodeEnv).toBe('production')
    expect(config.wechat.endpoint).toBe('https://api.weixin.qq.com/sns/jscode2session')
    expect(config.wechat.connectTimeoutMs).toBe(2_000)
    expect(config.wechat.totalTimeoutMs).toBe(5_000)
    expect(config.r2.forcePathStyle).toBe(false)
    expect(config.server).toEqual({
      host: '127.0.0.1',
      port: 3000,
      monitoringToken: 'production-monitor-token-at-least-32-characters',
      trustProxy: 1,
    })
  })

  it.each([
    ['WECHAT_APP_ID', 'example-app-id'],
    ['WECHAT_APP_SECRET', 'change-me'],
    ['WECHAT_AUTH_MODE', 'stub'],
    ['WECHAT_CODE2SESSION_ENDPOINT', 'http://api.weixin.qq.com/sns/jscode2session'],
    ['R2_ENDPOINT', 'http://127.0.0.1:9000'],
    ['R2_ENDPOINT', 'https://minio.internal.example'],
    ['R2_ENDPOINT', 'https://s3.internal.example'],
    ['R2_ENDPOINT', 'https://r2.cloudflarestorage.com'],
    ['R2_ENDPOINT', 'https://account.r2.cloudflarestorage.com.evil.example'],
    ['R2_ENDPOINT', 'https://user:password@account.r2.cloudflarestorage.com'],
    ['R2_ENDPOINT', 'https://account.r2.cloudflarestorage.com/bucket'],
    ['R2_ENDPOINT', 'https://account.r2.cloudflarestorage.com?bucket=value'],
    ['R2_ENDPOINT', 'https://account.r2.cloudflarestorage.com#bucket'],
    ['R2_ENDPOINT', 'https://account.r2.cloudflarestorage.com:8443'],
    ['R2_FORCE_PATH_STYLE', 'true'],
    ['JWT_PRIVATE_KEY', 'temporary-development-key'],
    ['JWT_PUBLIC_KEY', 'temporary-development-key'],
    ['HOST', 'api.internal.example'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['TRUST_PROXY', 'true'],
    ['TRUST_PROXY', 'loopback'],
    ['TRUST_PROXY', '0'],
    ['TRUST_PROXY', '2'],
    ['TRUST_PROXY', '-1'],
    ['TRUST_PROXY', '1.0'],
    ['TRUST_PROXY', '01'],
    ['TRUST_PROXY', '127.0.0.1'],
    ['TRUST_PROXY', '172.16.0.0/12'],
    ['TRUST_PROXY', '0.0.0.0/0'],
    ['TRUST_PROXY', '::/0'],
    ['MONITORING_TOKEN', 'change-me'],
    ['MONITORING_TOKEN', 'local-monitor-token-use-a-random-value'],
    ['MONITORING_TOKEN', 'replace-with-random-monitoring-token'],
    ['MONITORING_TOKEN', 'use-a-random-value-use-a-random-value'],
  ])('rejects unsafe production %s', (name, value) => {
    expect(() => loadRuntimeConfig({ ...productionEnv, [name]: value })).toThrow(new RegExp(name))
  })

  it('rejects a valid Ed25519 public key that does not match the private key', () => {
    const wrongPublicKey = mismatchedPublicKey.export({ format: 'pem', type: 'spki' }).toString()

    expect(() =>
      loadRuntimeConfig({
        ...productionEnv,
        JWT_PUBLIC_KEY: wrongPublicKey,
      }),
    ).toThrow(/JWT_PUBLIC_KEY/)
  })

  it('requires every external production setting', () => {
    for (const name of [
      'DATABASE_URL',
      'WECHAT_APP_ID',
      'WECHAT_APP_SECRET',
      'JWT_PRIVATE_KEY',
      'JWT_PUBLIC_KEY',
      'R2_ENDPOINT',
      'R2_BUCKET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'MONITORING_TOKEN',
    ]) {
      const env = Object.fromEntries(Object.entries(productionEnv).filter(([key]) => key !== name))
      expect(() => loadRuntimeConfig(env), name).toThrow(new RegExp(name))
    }
  })

  it('never echoes a secret value in validation errors', () => {
    const secret = 'super-secret-do-not-echo'

    try {
      loadRuntimeConfig({
        ...productionEnv,
        WECHAT_APP_SECRET: secret,
        R2_SECRET_ACCESS_KEY: secret,
        JWT_PRIVATE_KEY: secret,
      })
      throw new Error('expected configuration validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(secret)
    }
  })
})

describe('runtime adapter mode safety', () => {
  it('allows the development stub with local MinIO settings', () => {
    const config = loadRuntimeConfig(developmentStubEnv)

    expect(config.wechat.authMode).toBe('stub')
    expect(config.r2).toMatchObject({
      endpoint: 'http://127.0.0.1:59000',
      forcePathStyle: true,
    })
  })

  it.each([
    'https://api.weixin.qq.com/sns/jscode2session/',
    'https://api.weixin.qq.com/sns/jscode2session?mode=real',
    'https://api.weixin.qq.com/sns/jscode2session#fragment',
    'https://user:password@api.weixin.qq.com/sns/jscode2session',
    'https://api.weixin.qq.com/sns/other',
  ])('rejects a non-canonical real WeChat endpoint: %s', (endpoint) => {
    expect(() =>
      loadRuntimeConfig({
        ...productionEnv,
        NODE_ENV: 'development',
        WECHAT_CODE2SESSION_ENDPOINT: endpoint,
      }),
    ).toThrow(/WECHAT_CODE2SESSION_ENDPOINT/)
  })

  it('rejects an unknown WeChat auth mode outside production', () => {
    expect(() =>
      loadRuntimeConfig({
        ...developmentStubEnv,
        WECHAT_AUTH_MODE: 'stbu',
      }),
    ).toThrow(/WECHAT_AUTH_MODE/)
  })
})
