import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Environment } from './config.js'
import { loadMaintenanceConfig } from './config.js'
import { createPool } from './db/pool.js'
import { RetentionCleaner, type RetentionCleanupResult } from './uploads/retention-cleaner.js'

export async function runMaintenanceOnce(
  env: Environment = process.env,
): Promise<RetentionCleanupResult> {
  const config = loadMaintenanceConfig(env)
  const pool = createPool(config.databaseUrl, undefined, {
    max: 1,
    applicationName: 'wx-retention-maintenance',
  })

  try {
    return await new RetentionCleaner({ pool }).runOnce()
  } finally {
    await pool.end()
  }
}

async function main(): Promise<void> {
  const result = await runMaintenanceOnce()
  console.log(JSON.stringify(result))
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'retention maintenance failed'
    console.error(message)
    process.exitCode = 1
  })
}
