import { createHash, timingSafeEqual } from 'node:crypto'

import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'

import { ApiError } from './errors.js'
import { authenticatedUserId } from './request-context.js'

export type RateLimitPolicyName = 'login' | 'refresh' | 'ordinary' | 'initialize' | 'history'
export type RateLimitIdentity = 'ip' | 'user'

export interface RateLimitPolicy {
  readonly policyName: RateLimitPolicyName
  readonly max: number
  readonly timeWindow: 60_000
  readonly identity: RateLimitIdentity
  readonly hook: 'preHandler'
  keyGenerator(request: FastifyRequest): string
}

const POLICIES: Readonly<
  Record<RateLimitPolicyName, { max: number; identity: RateLimitIdentity }>
> = {
  login: { max: 10, identity: 'ip' },
  refresh: { max: 30, identity: 'ip' },
  ordinary: { max: 120, identity: 'user' },
  initialize: { max: 10, identity: 'user' },
  history: { max: 60, identity: 'user' },
}

function createRateLimitPolicy(name: RateLimitPolicyName): RateLimitPolicy {
  const policy = POLICIES[name]
  return Object.freeze({
    policyName: name,
    ...policy,
    timeWindow: 60_000,
    hook: 'preHandler',
    keyGenerator(request: FastifyRequest) {
      if (policy.identity === 'ip') return `ip:${request.ip}`
      const userId = authenticatedUserId(request)
      if (userId === undefined) {
        throw new ApiError({
          code: 'UNAUTHORIZED',
          message: '请先登录',
          statusCode: 401,
        })
      }
      return `user:${userId}`
    },
  })
}

const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitPolicyName, RateLimitPolicy>> = {
  login: createRateLimitPolicy('login'),
  refresh: createRateLimitPolicy('refresh'),
  ordinary: createRateLimitPolicy('ordinary'),
  initialize: createRateLimitPolicy('initialize'),
  history: createRateLimitPolicy('history'),
}

export function rateLimitPolicy(name: RateLimitPolicyName): RateLimitPolicy {
  return RATE_LIMIT_POLICIES[name]
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function isMonitoringTokenValid(
  provided: string | string[] | undefined,
  expected: string,
): boolean {
  const normalized = typeof provided === 'string' ? provided : ''
  return timingSafeEqual(tokenDigest(normalized), tokenDigest(expected))
}

function needsNoStore(url: string): boolean {
  return /^\/v1\/(?:auth(?:\/|$)|profile(?:\/|$)|uploads(?:\/|$))/.test(url)
}

function configuredPolicy(value: unknown): RateLimitPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const policyName: unknown = 'policyName' in value ? value.policyName : undefined
  if (typeof policyName !== 'string' || !(policyName in RATE_LIMIT_POLICIES)) return undefined
  return RATE_LIMIT_POLICIES[policyName as RateLimitPolicyName]
}

export function installSecurity(app: FastifyInstance): void {
  const groupLimiters = new Map<RateLimitPolicyName, ReturnType<typeof app.rateLimit>>()
  app.addHook('onRequest', async (request, reply) => {
    if (needsNoStore(request.url)) reply.header('Cache-Control', 'no-store')
  })
  app.addHook('onRoute', (routeOptions) => {
    const policy = configuredPolicy(routeOptions.config?.rateLimit)
    if (policy === undefined) return

    const applyGroupLimit: preHandlerAsyncHookHandler = async (request, reply) => {
      let limiter = groupLimiters.get(policy.policyName)
      if (limiter === undefined) {
        limiter = app.rateLimit(policy)
        groupLimiters.set(policy.policyName, limiter)
      }
      await limiter.call(app, request, reply)
    }
    const existing = routeOptions.preHandler
    routeOptions.preHandler =
      existing === undefined
        ? [applyGroupLimit]
        : Array.isArray(existing)
          ? [...existing, applyGroupLimit]
          : [existing, applyGroupLimit]
  })
  app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    skipOnError: false,
  })
}
