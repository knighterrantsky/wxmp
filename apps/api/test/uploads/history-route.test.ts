import type { UploadHistoryResponse } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import type { AccessTokenVerifier } from '../../src/auth/auth-routes.js'
import type {
  UploadHistoryRouteService,
  UploadRouteService,
} from '../../src/uploads/upload-routes.js'
import { registerUploadRoutes } from '../../src/uploads/upload-routes.js'
import { fakeDependencies } from '../support/fakes.js'

const userId = '01981c9e-6c80-7000-8000-000000000001'
const sessionId = '01981c9e-6c80-7000-8000-000000000002'
const uploadId = '01981c9e-6c80-7000-8000-000000000003'
const mediaId = '01981c9e-6c80-7000-8000-000000000004'
const now = new Date('2026-07-15T04:00:00.000Z')

const publicHistory: UploadHistoryResponse['data'] = {
  items: [
    {
      id: uploadId,
      mediaId,
      status: 'uploaded',
      fileName: '微信图片.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 12,
      progress: { confirmedBytes: 12, totalBytes: 12, percent: 100 },
      failure: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  ],
}

function uploadStub(): UploadRouteService {
  const outside = () => Promise.reject(new Error('outside history route test'))
  return {
    initialize: outside,
    uploadPart: outside,
    getDetail: outside,
    complete: outside,
    abort: outside,
  }
}

const apps: ReturnType<typeof buildAppShell>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture() {
  const tokens: AccessTokenVerifier = {
    verifyAccessToken: vi.fn().mockResolvedValue({ sub: userId, sid: sessionId }),
  }
  const list = vi.fn<UploadHistoryRouteService['list']>().mockResolvedValue({
    data: {
      ...publicHistory,
      privateObjectKey: 'users/private/secret.jpg',
      privateUploadId: 'private-multipart-id',
    } as UploadHistoryResponse['data'],
    pagination: { limit: 1, hasMore: false, nextCursor: null },
  })
  const app = buildAppShell(fakeDependencies({ clock: { now: () => now } }))
  registerUploadRoutes(app, { uploads: uploadStub(), history: { list }, tokens })
  apps.push(app)
  return { app, list }
}

describe('GET /v1/uploads', () => {
  it('returns a strict public list envelope and forwards normalized query ownership', async () => {
    const { app, list } = fixture()

    const response = await app.inject({
      method: 'GET',
      url: '/v1/uploads?limit=1&status=uploaded',
      headers: { authorization: 'Bearer valid-access-token' },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({
      data: publicHistory,
      meta: {
        requestId: response.headers['x-request-id'],
        serverTime: now.toISOString(),
        pagination: { limit: 1, hasMore: false, nextCursor: null },
      },
    })
    expect(list).toHaveBeenCalledWith({
      userId,
      query: { limit: 1, status: 'uploaded' },
    })
    expect(response.body).not.toMatch(/privateObjectKey|privateUploadId|secret\.jpg/u)
  })

  it('enforces the dedicated 60 requests per user per minute history budget', async () => {
    const { app, list } = fixture()

    const responses = []
    for (let index = 0; index < 61; index += 1) {
      responses.push(
        await app.inject({
          method: 'GET',
          url: '/v1/uploads',
          headers: { authorization: 'Bearer valid-access-token' },
        }),
      )
    }

    expect(responses.slice(0, 60).every((response) => response.statusCode === 200)).toBe(true)
    expect(responses[60]?.statusCode).toBe(429)
    expect(responses[60]?.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(list).toHaveBeenCalledTimes(60)
  })
})
