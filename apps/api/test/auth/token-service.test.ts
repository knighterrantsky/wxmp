import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_SECONDS,
  Ed25519TokenService,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../../src/auth/token-service.js'

const now = new Date('2026-07-15T03:00:00.000Z')
const userId = '01981c9e-6c80-7000-8000-000000000001'
const sessionId = '01981c9e-6c80-7000-8000-000000000002'
const tokenId = '01981c9e-6c80-7000-8000-000000000003'

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    signingKey: privateKey,
  }
}

function service(overrides: Partial<ConstructorParameters<typeof Ed25519TokenService>[0]> = {}) {
  const keys = keyMaterial()
  return {
    keys,
    tokens: new Ed25519TokenService({
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      clock: { now: () => now },
      ids: { next: () => tokenId },
      ...overrides,
    }),
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function signedToken(
  privateKey: ReturnType<typeof keyMaterial>['signingKey'],
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string {
  const issuedAt = Math.floor(now.getTime() / 1_000)
  const header = base64UrlJson({ alg: 'EdDSA', typ: 'JWT', ...headerOverrides })
  const payload = base64UrlJson({
    iss: ACCESS_TOKEN_ISSUER,
    aud: ACCESS_TOKEN_AUDIENCE,
    sub: userId,
    sid: sessionId,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
    jti: tokenId,
    typ: 'user',
    ...payloadOverrides,
  })
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

describe('Ed25519TokenService', () => {
  it('issues a strict 15-minute EdDSA user token and verifies its subject and session', async () => {
    const { tokens } = service()

    const token = await tokens.issueAccessToken({ userId, sessionId })
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
    const header = JSON.parse(
      Buffer.from(encodedHeader ?? '', 'base64url').toString('utf8'),
    ) as unknown
    const payload = JSON.parse(
      Buffer.from(encodedPayload ?? '', 'base64url').toString('utf8'),
    ) as unknown

    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT' })
    expect(payload).toEqual({
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
      sub: userId,
      sid: sessionId,
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(now.getTime() / 1_000) + 900,
      jti: tokenId,
      typ: 'user',
    })
    expect(Buffer.from(encodedSignature ?? '', 'base64url')).toHaveLength(64)
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual({ sub: userId, sid: sessionId })
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900)
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(2_592_000)
  })

  it('maps a valid expired token to TOKEN_EXPIRED', async () => {
    const keys = keyMaterial()
    const issuedAt = Math.floor(now.getTime() / 1_000) - ACCESS_TOKEN_TTL_SECONDS
    const tokens = new Ed25519TokenService({
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      clock: { now: () => now },
      ids: { next: () => tokenId },
    })
    const token = signedToken(keys.signingKey, {
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
    })

    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      statusCode: 401,
    })
  })

  it.each([
    ['wrong issuer', { iss: 'other-service' }, {}],
    ['wrong audience', { aud: 'other-client' }, {}],
    ['wrong token type', { typ: 'admin' }, {}],
    ['wrong lifetime', { exp: Math.floor(now.getTime() / 1_000) + 901 }, {}],
    ['future issued-at', { iat: Math.floor(now.getTime() / 1_000) + 61 }, {}],
    ['invalid subject', { sub: 'openid-must-not-be-a-subject' }, {}],
    ['invalid session', { sid: 'not-a-session-id' }, {}],
    ['invalid token id', { jti: 'not-a-token-id' }, {}],
    ['wrong algorithm', {}, { alg: 'none' }],
    ['extra header', {}, { kid: 'unexpected' }],
    ['extra claim', { role: 'admin' }, {}],
  ])('rejects a token with %s as UNAUTHORIZED', async (_name, payload, header) => {
    const keys = keyMaterial()
    const tokens = new Ed25519TokenService({
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      clock: { now: () => now },
      ids: { next: () => tokenId },
    })
    const token = signedToken(keys.signingKey, payload, header)

    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    })
  })

  it.each([
    '',
    'one.segment',
    'one.two.three.four',
    '***.e30.signature',
    `${'a'.repeat(4097)}.b.c`,
  ])('rejects malformed JWT input without leaking parser details: %j', async (token) => {
    const { tokens } = service()
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    })
  })

  it('rejects a payload or signature that was changed after signing', async () => {
    const { tokens } = service()
    const original = await tokens.issueAccessToken({ userId, sessionId })
    const [header = '', payload = '', signature = ''] = original.split('.')
    const changedPayload = base64UrlJson({ sub: userId })

    await expect(
      tokens.verifyAccessToken(`${header}.${changedPayload}.${signature}`),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 })

    const changedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`
    await expect(
      tokens.verifyAccessToken(`${header}.${payload}.${changedSignature}`),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 })
  })

  it('generates an opaque 256-bit refresh token and stores only its SHA-256 hash', () => {
    const random = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
    const { tokens } = service({ randomBytes: (size) => random.subarray(0, size) })

    const refresh = tokens.createRefreshToken()

    expect(refresh.token).toBe(`rft_${random.toString('base64url')}`)
    expect(refresh.token).not.toContain(refresh.hash.toString('hex'))
    expect(refresh.hash).toEqual(createHash('sha256').update(refresh.token, 'utf8').digest())
    expect(tokens.hashRefreshToken(refresh.token)).toEqual(refresh.hash)
    expect(refresh.hash).toHaveLength(32)
  })

  it.each(['', 'rft_short', `rft_${'a'.repeat(42)}=`, `other_${'a'.repeat(43)}`])(
    'maps malformed refresh token %j to REFRESH_TOKEN_INVALID',
    (token) => {
      const { tokens } = service()
      expect(() => tokens.hashRefreshToken(token)).toThrow(
        expect.objectContaining({ code: 'REFRESH_TOKEN_INVALID', statusCode: 401 }),
      )
    },
  )

  it('rejects non-Ed25519 or mismatched signing material at construction', () => {
    const edA = keyMaterial()
    const edB = keyMaterial()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })

    expect(
      () =>
        new Ed25519TokenService({
          privateKey: edA.privateKey,
          publicKey: edB.publicKey,
          clock: { now: () => now },
          ids: { next: () => tokenId },
        }),
    ).toThrow(/signing keys/i)
    expect(
      () =>
        new Ed25519TokenService({
          privateKey: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
          publicKey: rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          clock: { now: () => now },
          ids: { next: () => tokenId },
        }),
    ).toThrow(/Ed25519/i)
  })
})
