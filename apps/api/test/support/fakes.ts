import { createHash } from 'node:crypto'

import { Pool } from 'pg'

import type { AppDependencies } from '../../src/app.js'
import type { AuthRepository } from '../../src/auth/auth-repository.js'
import type { TokenService } from '../../src/auth/token-service.js'
import { WechatStubGateway } from '../../src/auth/wechat-stub-gateway.js'
import type { WechatGateway } from '../../src/auth/wechat-gateway.js'
import { Metrics } from '../../src/observability/metrics.js'

export interface FakeDependencyOverrides {
  databaseReady?: boolean
  objectStorageReady?: boolean
  databaseProbe?: (signal: AbortSignal) => Promise<boolean>
  objectStorageProbe?: (signal: AbortSignal) => Promise<boolean>
  monitoringToken?: string
  logger?: AppDependencies['logger']
  clock?: AppDependencies['clock']
  ids?: AppDependencies['ids']
  metrics?: AppDependencies['metrics']
  pool?: AppDependencies['pool']
  trustProxy?: AppDependencies['trustProxy']
  wechatAppId?: string
  wechatGateway?: WechatGateway
  tokenService?: TokenService
  authRepository?: AuthRepository
}

export interface FakeDependencies extends AppDependencies {
  probes: {
    databaseCalls: number
    objectStorageCalls: number
    databaseSignals: AbortSignal[]
    objectStorageSignals: AbortSignal[]
  }
}

export function fakeDependencies(overrides: FakeDependencyOverrides = {}): FakeDependencies {
  const probes: FakeDependencies['probes'] = {
    databaseCalls: 0,
    objectStorageCalls: 0,
    databaseSignals: [],
    objectStorageSignals: [],
  }
  const databaseProbe =
    overrides.databaseProbe ?? (() => Promise.resolve(overrides.databaseReady ?? true))
  const objectStorageProbe =
    overrides.objectStorageProbe ?? (() => Promise.resolve(overrides.objectStorageReady ?? true))
  const defaultRefreshToken = `rft_${'a'.repeat(43)}`
  const defaultTokenService: TokenService = {
    issueAccessToken: () => Promise.resolve('test-access-token'),
    verifyAccessToken: () =>
      Promise.resolve({
        sub: '01981c31-4c80-7000-8000-000000000011',
        sid: '01981c31-4c80-7000-8000-000000000012',
      }),
    createRefreshToken: () => ({
      token: defaultRefreshToken,
      hash: createHash('sha256').update(defaultRefreshToken, 'utf8').digest(),
    }),
    hashRefreshToken: (token) => createHash('sha256').update(token, 'utf8').digest(),
  }

  return {
    pool: overrides.pool ?? new Pool(),
    readiness: {
      async database(signal) {
        probes.databaseCalls += 1
        probes.databaseSignals.push(signal)
        return databaseProbe(signal)
      },
      async objectStorage(signal) {
        probes.objectStorageCalls += 1
        probes.objectStorageSignals.push(signal)
        return objectStorageProbe(signal)
      },
    },
    clock: overrides.clock ?? { now: () => new Date('2026-07-15T01:00:00.000Z') },
    ids: overrides.ids ?? {
      next: () => '01981c31-4c80-7000-8000-000000000001',
    },
    logger: overrides.logger ?? false,
    metrics: overrides.metrics ?? new Metrics(),
    monitoringToken: overrides.monitoringToken ?? 'monitor-test-token-32-characters',
    trustProxy: overrides.trustProxy ?? false,
    wechatAppId: overrides.wechatAppId ?? 'wx-test-app',
    wechatGateway: overrides.wechatGateway ?? new WechatStubGateway(),
    tokenService: overrides.tokenService ?? defaultTokenService,
    ...(overrides.authRepository === undefined ? {} : { authRepository: overrides.authRepository }),
    probes,
  }
}
