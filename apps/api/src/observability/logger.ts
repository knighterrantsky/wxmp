import pino, { type DestinationStream, type Logger } from 'pino'

const REDACTED = '[REDACTED]'
const OMITTED = '[OMITTED]'

const PRIVATE_KEY_SUFFIXES = [
  'authorization',
  'cookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'monitoringtoken',
  'sessiontoken',
  'secret',
  'appsecret',
  'clientsecret',
  'secretaccesskey',
  'r2secretaccesskey',
  'sessionkey',
  'nickname',
  'openid',
  'unionid',
  'objectkey',
  'etag',
  'filename',
  'originalfilename',
  'password',
  'databaseurl',
  'jwtprivatekey',
] as const
const OMITTED_KEYS = new Set(['body', 'headers', 'query', 'rawheaders'])
const URL_KEYS = new Set(['url', 'originalurl', 'rawurl'])

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isPrivateKey(key: string): boolean {
  return PRIVATE_KEY_SUFFIXES.some((suffix) => key === suffix || key.endsWith(suffix))
}

function stripConfiguredSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret === '' ? safe : safe.replaceAll(secret, REDACTED)),
    value,
  )
}

function safeUrl(): string {
  return OMITTED
}

function sanitize(value: unknown, secrets: readonly string[], seen = new WeakSet()): unknown {
  if (typeof value === 'string') return stripConfiguredSecrets(value, secrets)
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function') return OMITTED
  if (Buffer.isBuffer(value)) return '[BINARY]'
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    const code: unknown = Reflect.get(value, 'code')
    return {
      type: value.name,
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, seen))

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedKey(key)
    if (isPrivateKey(normalized)) {
      output[key] = REDACTED
    } else if (OMITTED_KEYS.has(normalized)) {
      output[key] = OMITTED
    } else if (URL_KEYS.has(normalized)) {
      output[key] = safeUrl()
    } else {
      output[key] = sanitize(item, secrets, seen)
    }
  }
  return output
}

export interface ProductionLoggerOptions {
  environment: string
  service: string
  secrets: readonly string[]
  destination?: DestinationStream
}

const PINO_REDACTION_PATHS = [
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'token',
  'accessToken',
  'refreshToken',
  'monitoringToken',
  'secret',
  'appSecret',
  'secretAccessKey',
  'nickname',
  'openid',
  'openId',
  'objectKey',
  'etag',
  'ETag',
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.Cookie',
  '*.token',
  '*.secret',
  '*.nickname',
  '*.openid',
  '*.objectKey',
] as const

export function createProductionLogger(options: ProductionLoggerOptions): Logger {
  const loggerOptions: pino.LoggerOptions = {
    base: { service: options.service, environment: options.environment },
    mixin: () => ({ timestamp: new Date().toISOString() }),
    redact: { paths: [...PINO_REDACTION_PATHS], censor: REDACTED },
    serializers: {
      err: (value) => sanitize(value, options.secrets),
      req: (value) => sanitize(value, options.secrets),
      res: (value) => sanitize(value, options.secrets),
    },
    hooks: {
      logMethod(args, method) {
        const safeArgs = args.map((argument) => sanitize(argument, options.secrets)) as Parameters<
          typeof method
        >
        method.apply(this, safeArgs)
      },
    },
  }
  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination)
}
