import { createHash } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  startLocalPrivateUploadHarness,
  type LocalPrivateUploadHarness,
} from '../support/local-private-upload-harness.js'

const INITIALIZE_KEY = '019f11a0-1000-7000-8000-000000000001'
const COMPLETE_KEY = '019f11a0-1000-7000-8000-000000000002'
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8, 0x42),
])

interface DataEnvelope<T> {
  data: T
}

async function requestJson<T>(
  harness: LocalPrivateUploadHarness,
  path: string,
  init: RequestInit,
): Promise<{ response: Response; body: DataEnvelope<T> }> {
  const response = await fetch(`${harness.origin}${path}`, init)
  const body: unknown = await response.json()
  return { response, body: body as DataEnvelope<T> }
}

describe('private upload API flow against PostgreSQL and MinIO', () => {
  let harness: LocalPrivateUploadHarness | undefined

  beforeAll(async () => {
    harness = await startLocalPrivateUploadHarness({ label: 'api-e2e' })
  })

  afterAll(async () => {
    await harness?.close()
  })

  it('maps WeChat identity to nickname and reaches uploaded history through the real finalizer', async () => {
    if (harness === undefined) throw new Error('Local E2E harness did not start')
    const login = await requestJson<{
      accessToken: string
      user: { id: string; nickname: string | null; nicknameConfirmed: boolean }
    }>(harness, '/v1/auth/wechat-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'dev:api-e2e-user', deviceId: 'api-e2e-device' }),
    })
    expect(login.response.status, JSON.stringify(login.body)).toBe(200)
    expect(login.body.data.user).toMatchObject({ nickname: null, nicknameConfirmed: false })
    expect(JSON.stringify(login.body)).not.toMatch(/openid|unionid|session[_-]?key/i)
    const accessToken = login.body.data.accessToken
    const userId = login.body.data.user.id

    const nickname = await requestJson<{
      user: { id: string; nickname: string | null; nicknameConfirmed: boolean }
    }>(harness, '/v1/profile/nickname', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        nickname: '微信昵称小晴',
        source: 'wechatNicknameInput',
        confirmed: true,
      }),
    })
    expect(nickname.response.status, JSON.stringify(nickname.body)).toBe(200)
    expect(nickname.body.data.user).toMatchObject({
      id: userId,
      nickname: '微信昵称小晴',
      nicknameConfirmed: true,
    })

    const identity = await harness.migrationPool.query<{
      id: string
      nickname: string
      nickname_confirmed_at: Date
      openid: string
    }>(
      `select u.id, u.nickname, u.nickname_confirmed_at, i.openid
         from media_app.users u
         join media_app.user_identities i on i.user_id = u.id
        where u.id = $1 and i.provider = 'wechat_miniprogram'`,
      [userId],
    )
    expect(identity.rows).toHaveLength(1)
    expect(identity.rows[0]).toMatchObject({ id: userId, nickname: '微信昵称小晴' })
    expect(identity.rows[0]?.openid).toMatch(/^stub_[0-9a-f]{48}$/)
    expect(identity.rows[0]?.nickname_confirmed_at).toBeInstanceOf(Date)

    const initialized = await requestJson<{
      upload: {
        id: string
        status: string
        fileName: string
        sizeBytes: number
        partCount: number
      }
    }>(harness, '/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': INITIALIZE_KEY,
      },
      body: JSON.stringify({
        fileName: 'e2e-private.png',
        kind: 'image',
        mimeType: 'image/png',
        sizeBytes: PNG_BYTES.byteLength,
      }),
    })
    expect(initialized.response.status, JSON.stringify(initialized.body)).toBe(201)
    expect(initialized.body.data.upload).toMatchObject({
      status: 'uploading',
      fileName: 'e2e-private.png',
      sizeBytes: PNG_BYTES.byteLength,
      partCount: 1,
    })
    const uploadId = initialized.body.data.upload.id

    const multipart = new FormData()
    multipart.append('chunkSizeBytes', String(PNG_BYTES.byteLength))
    multipart.append('chunk', new Blob([PNG_BYTES], { type: 'application/octet-stream' }), 'part-1')
    const part = await requestJson<unknown>(harness, `/v1/uploads/${uploadId}/parts/1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-chunk-sha256': createHash('sha256').update(PNG_BYTES).digest('hex'),
      },
      body: multipart,
    })
    expect(part.response.status, JSON.stringify(part.body)).toBe(200)
    expect(part.body.data).toMatchObject({
      part: { partNumber: 1, sizeBytes: PNG_BYTES.byteLength, status: 'uploaded' },
      progress: { confirmedBytes: PNG_BYTES.byteLength, percent: 100 },
    })

    const completed = await requestJson<unknown>(harness, `/v1/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': COMPLETE_KEY,
      },
      body: '{}',
    })
    expect(completed.response.status, JSON.stringify(completed.body)).toBe(202)
    expect(completed.body.data).toMatchObject({
      upload: { id: uploadId, status: 'finalizing' },
      pollAfterSeconds: 2,
    })

    await expect(harness.finalizer.runOnce(10)).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    })

    const detail = await requestJson<{ upload: unknown }>(harness, `/v1/uploads/${uploadId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(detail.response.status, JSON.stringify(detail.body)).toBe(200)
    expect(detail.body.data.upload).toMatchObject({
      id: uploadId,
      status: 'uploaded',
      progress: { confirmedBytes: PNG_BYTES.byteLength, percent: 100 },
    })

    const history = await requestJson<{
      items: {
        id: string
        status: string
        fileName: string
        progress: { percent: number }
      }[]
    }>(harness, '/v1/uploads?limit=20', {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(history.response.status, JSON.stringify(history.body)).toBe(200)
    expect(history.body.data.items).toHaveLength(1)
    expect(history.body.data.items[0]).toMatchObject({
      id: uploadId,
      status: 'uploaded',
      fileName: 'e2e-private.png',
    })
    expect(history.body.data.items[0]?.progress.percent).toBe(100)
    expect(JSON.stringify(history.body)).not.toMatch(/openid|r2|object[_-]?key|etag/i)

    const object = await harness.migrationPool.query<{
      object_key: string
      storage_status: string
      uploader_nickname_snapshot: string
    }>(
      `select m.object_key, m.storage_status, m.uploader_nickname_snapshot
         from media_app.media_objects m
         join media_app.upload_sessions u on u.media_object_id = m.id
        where u.id = $1`,
      [uploadId],
    )
    expect(object.rows[0]).toMatchObject({
      storage_status: 'ready',
      uploader_nickname_snapshot: '微信昵称小晴',
    })
    const objectKey = object.rows[0]?.object_key
    if (objectKey === undefined) throw new Error('E2E object key was not persisted')
    const anonymous = await fetch(
      `${harness.r2Config.endpoint}/${harness.r2Config.bucket}/${objectKey
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
    )
    expect(anonymous.status).toBe(403)
    await anonymous.body?.cancel()
  })
})
