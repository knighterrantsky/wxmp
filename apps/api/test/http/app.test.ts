import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { sendData } from '../../src/http/envelope.js'
import { ApiError } from '../../src/http/errors.js'
import { fakeDependencies } from '../support/fakes.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('Fastify application shell', () => {
  it('rejects unknown JSON body fields instead of silently removing them', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.post(
      '/__test/validated-body',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['partNumber'],
            properties: { partNumber: { type: 'integer' } },
          },
        },
      },
      (request) => request.body,
    )

    const response = await app.inject({
      method: 'POST',
      url: '/__test/validated-body',
      payload: { partNumber: 1, unexpectedSecret: 'must-not-be-ignored' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: '请求参数无效',
        retryable: false,
      },
    })
  })

  it('retains numeric coercion for URL query parameters', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.get(
      '/__test/query',
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['limit'],
            properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
          },
        },
      },
      (request) => request.query,
    )

    const response = await app.inject({ method: 'GET', url: '/__test/query?limit=20' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ limit: 20 })
  })

  it('returns liveness with a server-controlled request id', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'not-a-valid-id' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
    expect(response.headers['x-request-id']).toMatch(UUID_V7)
    expect(response.headers['x-request-id']).not.toBe('not-a-valid-id')
  })

  it('uses one request id in the header and standard data envelope', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.get('/__test/data', (_request, reply) => sendData(reply, { accepted: true }, 201))

    const response = await app.inject({ method: 'GET', url: '/__test/data' })
    const body: unknown = response.json()

    expect(response.statusCode).toBe(201)
    expect(body).toEqual({
      data: { accepted: true },
      meta: {
        requestId: response.headers['x-request-id'],
        serverTime: '2026-07-15T01:00:00.000Z',
      },
    })
  })

  it('accepts only a single valid UUIDv7 supplied by the client', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    const supplied = '01981c31-4c80-7000-8000-000000000099'

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': supplied },
    })

    expect(response.headers['x-request-id']).toBe(supplied)
  })

  it('maps unknown exceptions to a safe error envelope', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.get('/__test/error', () => {
      throw new Error(
        'postgresql://admin:database-secret@db/internal select * from users; upstream-body',
      )
    })

    const response = await app.inject({ method: 'GET', url: '/__test/error' })
    const body: unknown = response.json()

    expect(response.statusCode).toBe(500)
    expect(body).toMatchObject({
      error: { code: 'INTERNAL_ERROR', retryable: true },
      meta: { requestId: response.headers['x-request-id'] },
    })
    expect(response.body).not.toMatch(/database-secret|select \*|upstream-body|postgresql:\/\//i)
  })

  it('returns a stable safe error for unknown routes', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/missing' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_NOT_FOUND', retryable: false },
      meta: { requestId: response.headers['x-request-id'] },
    })
  })

  it('never exposes unapproved error detail fields', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.get('/__test/api-error', () => {
      throw new ApiError({
        code: 'VALIDATION_ERROR',
        message:
          'postgresql://admin:database-secret@db/internal select * from users; upstream-body',
        statusCode: 422,
        details: { databaseUrl: 'postgresql://private-error-detail' },
      })
    })

    const response = await app.inject({ method: 'GET', url: '/__test/api-error' })

    expect(response.statusCode).toBe(422)
    expect(response.body).not.toMatch(
      /database-secret|private-error-detail|select \*|upstream-body|postgresql:\/\//i,
    )
    const body = response.json<{ error: Record<string, unknown> }>()
    expect(body.error['message']).toBe('请求参数无效')
    expect(body.error).not.toHaveProperty('details')
  })

  it('uses a stable public message while retaining approved error details', async () => {
    const app = buildApp(fakeDependencies())
    apps.push(app)
    app.get('/__test/file-too-large', () => {
      throw new ApiError({
        code: 'FILE_TOO_LARGE',
        message: 'SQL failed with password=do-not-return and upstream-body',
        statusCode: 413,
        details: { maxSizeBytes: 209_715_200, actualSizeBytes: 209_715_201 },
      })
    })

    const response = await app.inject({ method: 'GET', url: '/__test/file-too-large' })

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({
      error: {
        code: 'FILE_TOO_LARGE',
        message: '文件超过 200 MiB 上限',
        retryable: false,
        details: { maxSizeBytes: 209_715_200, actualSizeBytes: 209_715_201 },
      },
    })
    expect(response.body).not.toMatch(/do-not-return|upstream-body|password/i)
  })
})
