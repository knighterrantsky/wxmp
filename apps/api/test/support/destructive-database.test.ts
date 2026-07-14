import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS,
  loadDestructiveDatabaseTestConfig,
} from './destructive-database.js'

const safeOverride = {
  ALLOW_DESTRUCTIVE_DB_TESTS: 'true',
  MIGRATION_DATABASE_URL: 'postgresql://migrate:migrate-password@localhost:6543/wx_upload_test',
  DATABASE_URL: 'postgresql://runtime:runtime-password@localhost:6543/wx_upload_test',
  MAINTENANCE_DATABASE_URL:
    'postgresql://maintenance:maintenance-password@localhost:6543/wx_upload_test',
} satisfies Record<string, string>

describe('loadDestructiveDatabaseTestConfig', () => {
  it('uses only the exact isolated local defaults without opt-in', () => {
    expect(loadDestructiveDatabaseTestConfig({})).toEqual(DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS)
    expect(
      loadDestructiveDatabaseTestConfig({
        MIGRATION_DATABASE_URL: DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS.migrationDatabaseUrl,
        DATABASE_URL: DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS.runtimeDatabaseUrl,
        MAINTENANCE_DATABASE_URL: DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS.maintenanceDatabaseUrl,
      }),
    ).toEqual(DEFAULT_DESTRUCTIVE_DATABASE_TEST_URLS)
  })

  it('requires explicit opt-in for any non-default URL', () => {
    expect(() =>
      loadDestructiveDatabaseTestConfig({
        ...safeOverride,
        ALLOW_DESTRUCTIVE_DB_TESTS: undefined,
      }),
    ).toThrow(/ALLOW_DESTRUCTIVE_DB_TESTS/)
  })

  it('accepts three role URLs that resolve to the same loopback test database', () => {
    expect(loadDestructiveDatabaseTestConfig(safeOverride)).toEqual({
      migrationDatabaseUrl: safeOverride.MIGRATION_DATABASE_URL,
      runtimeDatabaseUrl: safeOverride.DATABASE_URL,
      maintenanceDatabaseUrl: safeOverride.MAINTENANCE_DATABASE_URL,
    })
  })

  it.each(['db.internal', '192.168.1.20', '10.0.0.5'])(
    'rejects remote host %s even with opt-in',
    (hostname) => {
      expect(() =>
        loadDestructiveDatabaseTestConfig({
          ...safeOverride,
          MIGRATION_DATABASE_URL: `postgresql://migrate:password@${hostname}:6543/wx_upload_test`,
          DATABASE_URL: `postgresql://runtime:password@${hostname}:6543/wx_upload_test`,
          MAINTENANCE_DATABASE_URL: `postgresql://maintenance:password@${hostname}:6543/wx_upload_test`,
        }),
      ).toThrow(/loopback/i)
    },
  )

  it.each(['wx_upload', 'production', 'test-', 'wx-upload-test'])(
    'rejects unsafe override database name %s',
    (databaseName) => {
      expect(() =>
        loadDestructiveDatabaseTestConfig({
          ...safeOverride,
          MIGRATION_DATABASE_URL: `postgresql://migrate:password@127.0.0.1:6543/${databaseName}`,
          DATABASE_URL: `postgresql://runtime:password@127.0.0.1:6543/${databaseName}`,
          MAINTENANCE_DATABASE_URL: `postgresql://maintenance:password@127.0.0.1:6543/${databaseName}`,
        }),
      ).toThrow(/test database/i)
    },
  )

  it('rejects role URLs that do not point to one database', () => {
    expect(() =>
      loadDestructiveDatabaseTestConfig({
        ...safeOverride,
        DATABASE_URL: 'postgresql://runtime:password@localhost:6544/wx_upload_test',
      }),
    ).toThrow(/same database/i)
    expect(() =>
      loadDestructiveDatabaseTestConfig({
        ...safeOverride,
        MAINTENANCE_DATABASE_URL: 'postgresql://maintenance:password@localhost:6543/other_test',
      }),
    ).toThrow(/same database/i)
  })

  it.each([
    'https://runtime:password@localhost:6543/wx_upload_test',
    'postgresql://localhost:6543/wx_upload_test',
    'postgresql://runtime:password@localhost:6543/wx_upload_test?host=db.internal',
    'postgresql://runtime:password@localhost:6543/wx_upload_test#unsafe',
  ])('rejects malformed or ambiguous database URL %s', (runtimeDatabaseUrl) => {
    expect(() =>
      loadDestructiveDatabaseTestConfig({
        ...safeOverride,
        DATABASE_URL: runtimeDatabaseUrl,
      }),
    ).toThrow(/DATABASE_URL/)
  })
})
