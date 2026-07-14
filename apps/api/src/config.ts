import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto'

export type Environment = Readonly<Record<string, string | undefined>>
export type NodeEnvironment = 'development' | 'test' | 'production'

export interface RuntimeConfig {
  nodeEnv: NodeEnvironment
  databaseUrl: string
  wechat: {
    authMode: 'real' | 'stub'
    appId: string
    appSecret: string
    endpoint: string
    connectTimeoutMs: 2_000
    totalTimeoutMs: 5_000
  }
  jwt: {
    privateKey: string
    publicKey: string
  }
  r2: {
    endpoint: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle: boolean
  }
}

export interface MigrationConfig {
  databaseUrl: string
  runtimeRole: string
  maintenanceRole: string
}

export interface MaintenanceConfig {
  databaseUrl: string
}

const DEFAULT_WECHAT_ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session'
const PLACEHOLDER_PATTERN = /(?:change[-_ ]?me|example|placeholder|replace[-_ ]?me|temporary)/i
const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

function invalid(name: string): never {
  throw new Error(`Invalid configuration: ${name}`)
}

function required(env: Environment, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    invalid(name)
  }
  return value
}

function nonPlaceholder(env: Environment, name: string, minimumLength = 1): string {
  const value = required(env, name)
  if (value.length < minimumLength || PLACEHOLDER_PATTERN.test(value)) {
    invalid(name)
  }
  return value
}

function databaseUrl(env: Environment, name: string): string {
  const value = required(env, name)
  try {
    const parsed = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname === '') {
      invalid(name)
    }
  } catch {
    invalid(name)
  }
  return value
}

function nodeEnvironment(env: Environment): NodeEnvironment {
  const value = env['NODE_ENV'] ?? 'development'
  if (value !== 'development' && value !== 'test' && value !== 'production') {
    invalid('NODE_ENV')
  }
  return value
}

function wechatAuthMode(env: Environment): 'real' | 'stub' {
  const value = env['WECHAT_AUTH_MODE'] ?? 'stub'
  if (value !== 'real' && value !== 'stub') {
    invalid('WECHAT_AUTH_MODE')
  }
  return value
}

function booleanValue(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[name]
  if (value === undefined) {
    return fallback
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  return invalid(name)
}

function endpointUrl(value: string, name: string): URL {
  try {
    return new URL(value)
  } catch {
    return invalid(name)
  }
}

function databaseRole(value: string, name: string): string {
  const normalized = value.toLowerCase()
  if (
    !ROLE_PATTERN.test(value) ||
    normalized === 'public' ||
    normalized === 'postgres' ||
    normalized.startsWith('pg_')
  ) {
    invalid(name)
  }
  return value
}

function validateEd25519Keys(privateKey: string, publicKey: string): void {
  let parsedPrivateKey: ReturnType<typeof createPrivateKey>
  try {
    parsedPrivateKey = createPrivateKey(privateKey)
    if (parsedPrivateKey.asymmetricKeyType !== 'ed25519') {
      invalid('JWT_PRIVATE_KEY')
    }
  } catch {
    invalid('JWT_PRIVATE_KEY')
  }

  let parsedPublicKey: ReturnType<typeof createPublicKey>
  try {
    parsedPublicKey = createPublicKey(publicKey)
    if (parsedPublicKey.asymmetricKeyType !== 'ed25519') {
      invalid('JWT_PUBLIC_KEY')
    }
  } catch {
    invalid('JWT_PUBLIC_KEY')
  }

  const derivedPublicKey = createPublicKey(parsedPrivateKey).export({
    format: 'der',
    type: 'spki',
  })
  const suppliedPublicKey = parsedPublicKey.export({ format: 'der', type: 'spki' })
  if (
    derivedPublicKey.length !== suppliedPublicKey.length ||
    !timingSafeEqual(derivedPublicKey, suppliedPublicKey)
  ) {
    invalid('JWT_PUBLIC_KEY')
  }
}

export function loadRuntimeConfig(env: Environment): RuntimeConfig {
  const nodeEnv = nodeEnvironment(env)
  const runtimeDatabaseUrl = databaseUrl(env, 'DATABASE_URL')
  const authMode = wechatAuthMode(env)
  const endpoint = env['WECHAT_CODE2SESSION_ENDPOINT'] ?? DEFAULT_WECHAT_ENDPOINT
  const forcePathStyle = booleanValue(env, 'R2_FORCE_PATH_STYLE', false)

  if (authMode === 'real' && endpoint !== DEFAULT_WECHAT_ENDPOINT) {
    invalid('WECHAT_CODE2SESSION_ENDPOINT')
  }

  if (nodeEnv === 'test') {
    return {
      nodeEnv,
      databaseUrl: runtimeDatabaseUrl,
      wechat: {
        authMode,
        appId: env['WECHAT_APP_ID'] ?? '',
        appSecret: env['WECHAT_APP_SECRET'] ?? '',
        endpoint,
        connectTimeoutMs: 2_000,
        totalTimeoutMs: 5_000,
      },
      jwt: {
        privateKey: env['JWT_PRIVATE_KEY'] ?? '',
        publicKey: env['JWT_PUBLIC_KEY'] ?? '',
      },
      r2: {
        endpoint: env['R2_ENDPOINT'] ?? '',
        bucket: env['R2_BUCKET'] ?? '',
        accessKeyId: env['R2_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: env['R2_SECRET_ACCESS_KEY'] ?? '',
        forcePathStyle,
      },
    }
  }

  const appId = required(env, 'WECHAT_APP_ID')
  const appSecret = required(env, 'WECHAT_APP_SECRET')
  const privateKey = required(env, 'JWT_PRIVATE_KEY')
  const publicKey = required(env, 'JWT_PUBLIC_KEY')
  const r2EndpointValue = required(env, 'R2_ENDPOINT')
  const bucket = required(env, 'R2_BUCKET')
  const accessKeyId = required(env, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = required(env, 'R2_SECRET_ACCESS_KEY')

  if (nodeEnv === 'production') {
    if (authMode !== 'real') {
      invalid('WECHAT_AUTH_MODE')
    }
    if (appId.length < 8 || PLACEHOLDER_PATTERN.test(appId)) {
      invalid('WECHAT_APP_ID')
    }
    if (appSecret.length < 16 || PLACEHOLDER_PATTERN.test(appSecret)) {
      invalid('WECHAT_APP_SECRET')
    }

    validateEd25519Keys(privateKey, publicKey)

    const r2Endpoint = endpointUrl(r2EndpointValue, 'R2_ENDPOINT')
    const r2Hostname = r2Endpoint.hostname.toLowerCase()
    const r2HostnameSuffix = '.r2.cloudflarestorage.com'
    if (
      r2Endpoint.protocol !== 'https:' ||
      !r2Hostname.endsWith(r2HostnameSuffix) ||
      r2Hostname.length <= r2HostnameSuffix.length ||
      r2Endpoint.username !== '' ||
      r2Endpoint.password !== '' ||
      r2Endpoint.pathname !== '/' ||
      r2Endpoint.search !== '' ||
      r2Endpoint.hash !== '' ||
      r2Endpoint.port !== ''
    ) {
      invalid('R2_ENDPOINT')
    }
    if (forcePathStyle) {
      invalid('R2_FORCE_PATH_STYLE')
    }
    if (!BUCKET_PATTERN.test(bucket)) {
      invalid('R2_BUCKET')
    }
    nonPlaceholder(env, 'R2_ACCESS_KEY_ID', 12)
    nonPlaceholder(env, 'R2_SECRET_ACCESS_KEY', 16)
  }

  return {
    nodeEnv,
    databaseUrl: runtimeDatabaseUrl,
    wechat: {
      authMode,
      appId,
      appSecret,
      endpoint,
      connectTimeoutMs: 2_000,
      totalTimeoutMs: 5_000,
    },
    jwt: { privateKey, publicKey },
    r2: {
      endpoint: r2EndpointValue,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
    },
  }
}

export function loadMigrationConfig(env: Environment): MigrationConfig {
  const runtimeRole = databaseRole(
    env['DATABASE_RUNTIME_ROLE'] ?? 'wx_runtime',
    'DATABASE_RUNTIME_ROLE',
  )
  const maintenanceRole = databaseRole(
    env['DATABASE_MAINTENANCE_ROLE'] ?? 'wx_maintenance',
    'DATABASE_MAINTENANCE_ROLE',
  )
  if (runtimeRole === maintenanceRole) {
    invalid('database roles must be distinct')
  }
  return {
    databaseUrl: databaseUrl(env, 'MIGRATION_DATABASE_URL'),
    runtimeRole,
    maintenanceRole,
  }
}

export function loadMaintenanceConfig(env: Environment): MaintenanceConfig {
  return { databaseUrl: databaseUrl(env, 'MAINTENANCE_DATABASE_URL') }
}
