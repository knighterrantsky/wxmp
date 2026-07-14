import { Pool } from 'pg'

const CONNECTION_TIMEOUT_MS = 2_000
const QUERY_TIMEOUT_MS = 10_000
const STATEMENT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_CONNECTIONS = 20

export interface DatabasePoolOptions {
  max?: number
  applicationName?: string
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))) {
      return true
    }
  }
  return false
}

export function createPool(
  databaseUrl: string,
  onIdleClientError?: (error: Error) => void,
  options: DatabasePoolOptions = {},
): Pool {
  const max = options.max ?? DEFAULT_MAX_CONNECTIONS
  const applicationName = options.applicationName ?? 'wx-private-media-upload'
  if (!Number.isSafeInteger(max) || max < 1 || max > 100) {
    throw new RangeError('database pool max must be between 1 and 100')
  }
  if (
    applicationName.length < 1 ||
    applicationName.length > 63 ||
    hasControlCharacter(applicationName)
  ) {
    throw new RangeError('database application name is invalid')
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    max,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS,
  })
  pool.on('error', (error) => {
    try {
      onIdleClientError?.(error)
    } catch {
      // A logging failure must not turn an idle database socket error into an uncaught exception.
    }
  })
  return pool
}
