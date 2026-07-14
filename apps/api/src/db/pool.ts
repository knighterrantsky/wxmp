import { Pool } from 'pg'

const CONNECTION_TIMEOUT_MS = 2_000
const QUERY_TIMEOUT_MS = 10_000
const STATEMENT_TIMEOUT_MS = 10_000

export function createPool(databaseUrl: string, onIdleClientError?: (error: Error) => void): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'wx-private-media-upload',
    max: 10,
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
