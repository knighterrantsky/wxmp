type TestEnvironment = Readonly<Record<string, string | undefined>>

export interface DestructiveDatabaseTestConfig {
  migrationDatabaseUrl: string
  runtimeDatabaseUrl: string
  maintenanceDatabaseUrl: string
}

export const DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS: DestructiveDatabaseTestConfig = {
  migrationDatabaseUrl: 'postgresql://wx_migrate:wx_migrate_local@127.0.0.1:55432/wx_upload',
  runtimeDatabaseUrl: 'postgresql://wx_runtime:wx_runtime_local@127.0.0.1:55432/wx_upload',
  maintenanceDatabaseUrl:
    'postgresql://wx_maintenance:wx_maintenance_local@127.0.0.1:55432/wx_upload',
}

interface ParsedTestDatabaseUrl {
  identity: string
}

function invalid(name: string, reason?: string): never {
  throw new Error(
    reason === undefined
      ? `Unsafe destructive database test configuration: ${name}`
      : `Unsafe destructive database test configuration: ${name} ${reason}`,
  )
}

function parseTestDatabaseUrl(value: string, name: string): ParsedTestDatabaseUrl {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid(name)
  }

  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.username === '' ||
    parsed.password === '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    invalid(name)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    invalid(name, 'must use a loopback host')
  }

  let databaseName: string
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    return invalid(name)
  }
  if (!/^[a-z][a-z0-9_]*_test$/.test(databaseName)) {
    invalid(name, 'must name an isolated test database')
  }

  const port = parsed.port === '' ? '5432' : parsed.port
  return {
    identity: `${hostname}:${port}/${databaseName}`,
  }
}

export function loadDestructiveDatabaseTestConfig(
  env: TestEnvironment,
): DestructiveDatabaseTestConfig {
  const config = {
    migrationDatabaseUrl:
      env['MIGRATION_DATABASE_URL'] ?? DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS.migrationDatabaseUrl,
    runtimeDatabaseUrl:
      env['DATABASE_URL'] ?? DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS.runtimeDatabaseUrl,
    maintenanceDatabaseUrl:
      env['MAINTENANCE_DATABASE_URL'] ??
      DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS.maintenanceDatabaseUrl,
  }

  const usesExactDefaults = (Object.keys(config) as (keyof DestructiveDatabaseTestConfig)[]).every(
    (key) => config[key] === DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS[key],
  )
  if (usesExactDefaults) {
    return config
  }

  if (env['ALLOW_DESTRUCTIVE_DB_TESTS'] !== 'true') {
    invalid('ALLOW_DESTRUCTIVE_DB_TESTS')
  }

  const migration = parseTestDatabaseUrl(config.migrationDatabaseUrl, 'MIGRATION_DATABASE_URL')
  const runtime = parseTestDatabaseUrl(config.runtimeDatabaseUrl, 'DATABASE_URL')
  const maintenance = parseTestDatabaseUrl(
    config.maintenanceDatabaseUrl,
    'MAINTENANCE_DATABASE_URL',
  )

  if (migration.identity !== runtime.identity || migration.identity !== maintenance.identity) {
    invalid('database URLs', 'must point to the same database')
  }

  return config
}
