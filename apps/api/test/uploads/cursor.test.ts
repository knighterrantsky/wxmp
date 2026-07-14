import { describe, expect, it } from 'vitest'

import {
  HISTORY_CURSOR_TTL_SECONDS,
  SignedHistoryCursorCodec,
  type HistoryCursorFilter,
} from '../../src/uploads/cursor.js'

const userId = '01981c9e-6c80-7000-8000-000000000001'
const otherUserId = '01981c9e-6c80-7000-8000-000000000002'
const uploadId = '01981c9e-6c80-7000-8000-000000000003'
const createdAt = new Date('2026-07-15T03:00:00.123Z')
const signingSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1))

function filter(status: HistoryCursorFilter['status'] = null): HistoryCursorFilter {
  return { status }
}

function fixture(options: { ttlSeconds?: number } = {}) {
  let now = new Date('2026-07-15T04:00:00.000Z')
  const codec = new SignedHistoryCursorCodec({
    secret: signingSecret,
    clock: { now: () => new Date(now) },
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
  })
  return {
    codec,
    setNow: (value: Date) => {
      now = new Date(value)
    },
  }
}

function issue(
  codec: SignedHistoryCursorCodec,
  overrides: Partial<Parameters<SignedHistoryCursorCodec['encode']>[0]> = {},
): string {
  return codec.encode({
    userId,
    filter: filter(),
    createdAt,
    id: uploadId,
    ...overrides,
  })
}

async function expectInvalidCursor(action: () => unknown): Promise<void> {
  await expect(Promise.resolve().then(action)).rejects.toMatchObject({
    name: 'ApiError',
    code: 'INVALID_CURSOR',
    message: '游标无效或查询条件已改变',
    statusCode: 400,
    retryable: false,
  })
}

describe('SignedHistoryCursorCodec', () => {
  it('round-trips the stable createdAt DESC, id DESC position', () => {
    const { codec } = fixture()
    const cursor = issue(codec)

    expect(
      codec.decode(cursor, {
        userId,
        filter: filter(),
      }),
    ).toEqual({ createdAt, id: uploadId })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
    expect(cursor.length).toBeLessThan(4096)
    expect(HISTORY_CURSOR_TTL_SECONDS).toBe(86_400)
  })

  it('binds a cursor to the authenticated user and normalized status filter', async () => {
    const { codec } = fixture()
    const uploaded = filter('uploaded')
    const cursor = issue(codec, { filter: uploaded })

    expect(codec.decode(cursor, { userId, filter: uploaded })).toEqual({
      createdAt,
      id: uploadId,
    })
    await expectInvalidCursor(() => codec.decode(cursor, { userId: otherUserId, filter: uploaded }))
    await expectInvalidCursor(() => codec.decode(cursor, { userId, filter: filter() }))
    await expectInvalidCursor(() =>
      codec.decode(cursor, { userId, filter: filter('upload_failed') }),
    )
  })

  it('does not place the user id or filter value in the signed payload', () => {
    const { codec } = fixture()
    const status = 'upload_failed'
    const cursor = issue(codec, { filter: filter(status) })
    const [encodedPayload = ''] = cursor.split('.')
    const decodedPayload = Buffer.from(encodedPayload, 'base64url').toString('utf8')

    expect(decodedPayload).not.toContain(userId)
    expect(decodedPayload).not.toContain(status)
    expect(cursor).not.toContain(userId)
    expect(codec.decode(cursor, { userId, filter: filter(status) })).toEqual({
      createdAt,
      id: uploadId,
    })
  })

  it('rejects payload and signature tampering with the same safe public error', async () => {
    const { codec } = fixture()
    const cursor = issue(codec)
    const [payload = '', signature = ''] = cursor.split('.')
    const changedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`
    const changedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`

    await expectInvalidCursor(() =>
      codec.decode(`${changedPayload}.${signature}`, { userId, filter: filter() }),
    )
    await expectInvalidCursor(() =>
      codec.decode(`${payload}.${changedSignature}`, { userId, filter: filter() }),
    )
  })

  it.each([
    '',
    'one-segment',
    'one.two.three',
    '***.signature',
    `${'a'.repeat(4097)}.signature`,
    'e30.AA',
    '4pyT.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ])('maps malformed input %j to the same safe INVALID_CURSOR error', async (cursor) => {
    const { codec } = fixture()

    await expectInvalidCursor(() => codec.decode(cursor, { userId, filter: filter() }))
  })

  it('rejects a cursor at its expiry boundary with no distinct expiry signal', async () => {
    const { codec, setNow } = fixture({ ttlSeconds: 60 })
    const cursor = issue(codec)

    setNow(new Date('2026-07-15T04:00:59.999Z'))
    expect(codec.decode(cursor, { userId, filter: filter() })).toEqual({ createdAt, id: uploadId })

    setNow(new Date('2026-07-15T04:01:00.000Z'))
    await expectInvalidCursor(() => codec.decode(cursor, { userId, filter: filter() }))
  })

  it('rejects cursors signed by another deployment secret', async () => {
    const { codec } = fixture()
    const otherCodec = new SignedHistoryCursorCodec({
      secret: Buffer.alloc(32, 0xa5),
      clock: { now: () => new Date('2026-07-15T04:00:00.000Z') },
    })

    await expectInvalidCursor(() => otherCodec.decode(issue(codec), { userId, filter: filter() }))
  })

  it('rejects unsafe configuration and invalid positions before issuing a cursor', () => {
    expect(
      () =>
        new SignedHistoryCursorCodec({
          secret: Buffer.alloc(31),
          clock: { now: () => new Date('2026-07-15T04:00:00.000Z') },
        }),
    ).toThrow(/at least 32 bytes/i)
    expect(
      () =>
        new SignedHistoryCursorCodec({
          secret: signingSecret,
          clock: { now: () => new Date('2026-07-15T04:00:00.000Z') },
          ttlSeconds: 0,
        }),
    ).toThrow(/ttl/i)

    const { codec } = fixture()
    expect(() => issue(codec, { id: 'not-a-uuid' })).toThrow(/position/i)
    expect(() => issue(codec, { createdAt: new Date('invalid') })).toThrow(/position/i)
    expect(() => issue(codec, { userId: 'not-a-uuid' })).toThrow(/binding/i)
    expect(() =>
      issue(codec, {
        filter: {
          status: { toString: () => 'uploaded' } as unknown as HistoryCursorFilter['status'],
        },
      }),
    ).toThrow(/binding/i)
  })
})
