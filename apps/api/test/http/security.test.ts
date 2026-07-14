import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { setAuthenticatedUser } from '../../src/http/request-context.js'
import { rateLimitPolicy } from '../../src/http/security.js'
import { fakeDependencies } from '../support/fakes.js'

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function jsonBodyOfSize(size: number): string {
  const prefix = '{"value":"'
  const suffix = '"}'
  return `${prefix}${'a'.repeat(size - prefix.length - suffix.length)}${suffix}`
}

describe('HTTP security policy', () => {
  it('accepts 64 KiB JSON and rejects one additional byte safely', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.post('/__test/json', () => ({ ok: true }))

    const accepted = await app.inject({
      method: 'POST',
      url: '/__test/json',
      headers: { 'content-type': 'application/json' },
      payload: jsonBodyOfSize(65_536),
    })
    const rejected = await app.inject({
      method: 'POST',
      url: '/__test/json',
      headers: { 'content-type': 'application/json' },
      payload: jsonBodyOfSize(65_537),
    })

    expect(accepted.statusCode).toBe(200)
    expect(rejected.statusCode).toBe(413)
    expect(rejected.json()).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE', retryable: false },
    })
  })

  it('sets no-store on identity and upload success and error responses', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.get('/v1/profile', () => ({ ok: true }))
    app.get('/v1/uploads/test', () => {
      throw new Error('private failure')
    })

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/profile' }),
      app.inject({ method: 'GET', url: '/v1/uploads/test' }),
      app.inject({ method: 'GET', url: '/v1/auth/missing' }),
    ])

    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store')
    }
  })

  it.each([
    ['login', 10, 'ip'],
    ['ordinary', 120, 'user'],
    ['initialize', 10, 'user'],
    ['history', 60, 'user'],
  ] as const)('declares the %s rate policy', (name, max, identity) => {
    expect(rateLimitPolicy(name)).toMatchObject({
      max,
      timeWindow: 60_000,
      identity,
    })
  })

  it.each([
    ['login', 10],
    ['ordinary', 120],
    ['initialize', 10],
    ['history', 60],
  ] as const)('enforces the %s route policy at N + 1', async (name, max) => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    if (name !== 'login') {
      app.addHook('onRequest', (request) => {
        setAuthenticatedUser(request, '01981c31-4c80-7000-8000-000000000011')
        return Promise.resolve()
      })
    }
    app.post(`/__test/rate/${name}`, { config: { rateLimit: rateLimitPolicy(name) } }, () => ({
      ok: true,
    }))

    for (let index = 0; index < max; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/__test/rate/${name}`,
        headers: { 'x-forwarded-for': `198.51.100.${String(index % 200)}` },
        payload: { userId: `client-controlled-${String(index)}` },
      })
      expect(response.statusCode, `request ${String(index + 1)}`).toBe(200)
    }

    const limited = await app.inject({
      method: 'POST',
      url: `/__test/rate/${name}`,
      headers: { 'x-forwarded-for': '203.0.113.99' },
      payload: { userId: 'another-client-value' },
    })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', retryable: true },
    })
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1)
  })

  it('fails closed when a user-scoped rate policy has no authenticated context', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.post(
      '/__test/rate/ordinary',
      { config: { rateLimit: rateLimitPolicy('ordinary') } },
      () => ({ ok: true }),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/__test/rate/ordinary',
      payload: { userId: 'attacker-selected' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  it('runs a route authentication preHandler before user-scoped rate limiting', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.post(
      '/__test/rate/route-auth',
      {
        config: { rateLimit: rateLimitPolicy('initialize') },
        preHandler: (request) => {
          setAuthenticatedUser(request, '01981c31-4c80-7000-8000-000000000012')
          return Promise.resolve()
        },
      },
      () => ({ ok: true }),
    )

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/__test/rate/route-auth' })
      expect(response.statusCode, `request ${String(index + 1)}`).toBe(200)
    }
    expect((await app.inject({ method: 'POST', url: '/__test/rate/route-auth' })).statusCode).toBe(
      429,
    )
  })

  it('shares an ordinary user quota across routes in the same policy group', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.addHook('onRequest', (request) => {
      setAuthenticatedUser(request, '01981c31-4c80-7000-8000-000000000013')
      return Promise.resolve()
    })
    for (const route of ['a', 'b']) {
      app.post(
        `/__test/rate/shared/${route}`,
        { config: { rateLimit: rateLimitPolicy('ordinary') } },
        () => ({ ok: true }),
      )
    }

    for (let index = 0; index < 120; index += 1) {
      const route = index % 2 === 0 ? 'a' : 'b'
      const response = await app.inject({
        method: 'POST',
        url: `/__test/rate/shared/${route}`,
      })
      expect(response.statusCode, `aggregate request ${String(index + 1)}`).toBe(200)
    }
    expect((await app.inject({ method: 'POST', url: '/__test/rate/shared/b' })).statusCode).toBe(
      429,
    )
  })

  it('uses the client address from exactly one trusted reverse-proxy hop', async () => {
    const app = buildApp(fakeDependencies({ trustProxy: 1 }))
    apps.push(app)
    app.post(
      '/__test/rate/proxied-login',
      { config: { rateLimit: rateLimitPolicy('login') } },
      () => ({ ok: true }),
    )

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/__test/rate/proxied-login',
        headers: { 'x-forwarded-for': '192.0.2.10, 198.51.100.20' },
      })
      expect(response.statusCode, `client A request ${String(index + 1)}`).toBe(200)
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/__test/rate/proxied-login',
          headers: { 'x-forwarded-for': '192.0.2.11, 198.51.100.20' },
        })
      ).statusCode,
    ).toBe(429)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/__test/rate/proxied-login',
          headers: { 'x-forwarded-for': '192.0.2.10, 198.51.100.21' },
        })
      ).statusCode,
    ).toBe(200)
  })
})
