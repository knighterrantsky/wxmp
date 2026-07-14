import { Pool } from 'pg'

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    application_name: 'wx-private-media-upload',
    max: 10,
  })
}
