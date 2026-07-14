import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes as secureRandomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'

import { UUID_V7_PATTERN } from '@wx-upload/contracts'

import { ApiError } from '../http/errors.js'
import type { Clock } from '../lib/clock.js'
import type { IdGenerator } from '../lib/id.js'

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const ACCESS_TOKEN_ISSUER = 'wx-private-media-upload-api'
export const ACCESS_TOKEN_AUDIENCE = 'wx-private-media-upload-miniprogram'

const ACCESS_TOKEN_MAX_LENGTH = 4_096
const MAX_HEADER_BYTES = 512
const MAX_PAYLOAD_BYTES = 2_048
const ED25519_SIGNATURE_BYTES = 64
const REFRESH_TOKEN_BYTES = 32
const ALLOWED_CLOCK_SKEW_SECONDS = 60
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const REFRESH_TOKEN = /^rft_([A-Za-z0-9_-]{43})$/u
const UUID_V7 = new RegExp(UUID_V7_PATTERN, 'u')
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface AccessTokenClaims {
  readonly sub: string
  readonly sid: string
}

export interface TokenService {
  issueAccessToken(input: { userId: string; sessionId: string }): Promise<string>
  verifyAccessToken(token: string): Promise<AccessTokenClaims>
  createRefreshToken(): { token: string; hash: Buffer }
  hashRefreshToken(token: string): Buffer
}

export interface Ed25519TokenServiceConfig {
  readonly privateKey: string
  readonly publicKey: string
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly issuer?: string
  readonly audience?: string
  readonly randomBytes?: (size: number) => Buffer
}

type JwtRecord = Readonly<Record<string, unknown>>

function unauthorized(): ApiError {
  return new ApiError({
    code: 'UNAUTHORIZED',
    message: '请先登录',
    statusCode: 401,
  })
}

function expired(): ApiError {
  return new ApiError({
    code: 'TOKEN_EXPIRED',
    message: '登录凭据已过期',
    statusCode: 401,
  })
}

function invalidRefreshToken(): ApiError {
  return new ApiError({
    code: 'REFRESH_TOKEN_INVALID',
    message: '刷新凭据无效或已过期',
    statusCode: 401,
  })
}

function parseSigningKeys(
  privatePem: string,
  publicPem: string,
): {
  privateKey: KeyObject
  publicKey: KeyObject
} {
  let privateKey: KeyObject
  let publicKey: KeyObject
  try {
    privateKey = createPrivateKey(privatePem)
    publicKey = createPublicKey(publicPem)
  } catch {
    throw new Error('Invalid Ed25519 signing keys')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Signing keys must use Ed25519')
  }
  const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const supplied = publicKey.export({ format: 'der', type: 'spki' })
  if (derived.length !== supplied.length || !timingSafeEqual(derived, supplied)) {
    throw new Error('Invalid Ed25519 signing keys: public key does not match')
  }
  return { privateKey, publicKey }
}

function encodeJson(value: JwtRecord): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeBase64Url(segment: string, maximumBytes: number): Buffer {
  if (!BASE64URL.test(segment)) throw unauthorized()
  const decoded = Buffer.from(segment, 'base64url')
  if (
    decoded.length < 1 ||
    decoded.length > maximumBytes ||
    decoded.toString('base64url') !== segment
  ) {
    throw unauthorized()
  }
  return decoded
}

function parseRecord(bytes: Buffer): JwtRecord {
  let value: unknown
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes))
  } catch {
    throw unauthorized()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unauthorized()
  return value as JwtRecord
}

function hasExactKeys(record: JwtRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

function validUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value)
}

function validEpochSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function refreshTokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export class Ed25519TokenService implements TokenService {
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject
  readonly #clock: Clock
  readonly #ids: IdGenerator
  readonly #issuer: string
  readonly #audience: string
  readonly #randomBytes: (size: number) => Buffer

  constructor(config: Ed25519TokenServiceConfig) {
    const keys = parseSigningKeys(config.privateKey, config.publicKey)
    const issuer = config.issuer ?? ACCESS_TOKEN_ISSUER
    const audience = config.audience ?? ACCESS_TOKEN_AUDIENCE
    if (issuer.length < 1 || issuer.length > 128 || audience.length < 1 || audience.length > 128) {
      throw new Error('Invalid access-token issuer or audience')
    }
    this.#privateKey = keys.privateKey
    this.#publicKey = keys.publicKey
    this.#clock = config.clock
    this.#ids = config.ids
    this.#issuer = issuer
    this.#audience = audience
    this.#randomBytes = config.randomBytes ?? secureRandomBytes
  }

  issueAccessToken(input: { userId: string; sessionId: string }): Promise<string> {
    return Promise.resolve().then(() => {
      if (!validUuidV7(input.userId) || !validUuidV7(input.sessionId)) {
        throw new Error('Access-token identifiers must be UUIDv7 values')
      }
      const issuedAt = Math.floor(this.#clock.now().getTime() / 1_000)
      const tokenId = this.#ids.next()
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !validUuidV7(tokenId)) {
        throw new Error('Access-token clock or identifier is invalid')
      }
      const header = encodeJson({ alg: 'EdDSA', typ: 'JWT' })
      const payload = encodeJson({
        iss: this.#issuer,
        aud: this.#audience,
        sub: input.userId,
        sid: input.sessionId,
        iat: issuedAt,
        exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
        jti: tokenId,
        typ: 'user',
      })
      const signingInput = `${header}.${payload}`
      const signature = sign(null, Buffer.from(signingInput, 'ascii'), this.#privateKey)
      return `${signingInput}.${signature.toString('base64url')}`
    })
  }

  verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return Promise.resolve().then(() => {
      if (token.length < 1 || token.length > ACCESS_TOKEN_MAX_LENGTH) throw unauthorized()
      const segments = token.split('.')
      if (segments.length !== 3) throw unauthorized()
      const [encodedHeader, encodedPayload, encodedSignature] = segments
      if (
        encodedHeader === undefined ||
        encodedPayload === undefined ||
        encodedSignature === undefined
      ) {
        throw unauthorized()
      }

      const headerBytes = decodeBase64Url(encodedHeader, MAX_HEADER_BYTES)
      const payloadBytes = decodeBase64Url(encodedPayload, MAX_PAYLOAD_BYTES)
      const signature = decodeBase64Url(encodedSignature, ED25519_SIGNATURE_BYTES)
      if (signature.length !== ED25519_SIGNATURE_BYTES) throw unauthorized()

      const signingInput = `${encodedHeader}.${encodedPayload}`
      let signatureValid: boolean
      try {
        signatureValid = verify(
          null,
          Buffer.from(signingInput, 'ascii'),
          this.#publicKey,
          signature,
        )
      } catch {
        throw unauthorized()
      }
      if (!signatureValid) throw unauthorized()

      const header = parseRecord(headerBytes)
      const payload = parseRecord(payloadBytes)
      if (
        !hasExactKeys(header, ['alg', 'typ']) ||
        header['alg'] !== 'EdDSA' ||
        header['typ'] !== 'JWT' ||
        !hasExactKeys(payload, ['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'typ']) ||
        payload['iss'] !== this.#issuer ||
        payload['aud'] !== this.#audience ||
        payload['typ'] !== 'user' ||
        !validUuidV7(payload['sub']) ||
        !validUuidV7(payload['sid']) ||
        !validUuidV7(payload['jti']) ||
        !validEpochSeconds(payload['iat']) ||
        !validEpochSeconds(payload['exp'])
      ) {
        throw unauthorized()
      }

      const issuedAt = payload['iat']
      const expiresAt = payload['exp']
      const currentTime = Math.floor(this.#clock.now().getTime() / 1_000)
      if (
        !Number.isSafeInteger(currentTime) ||
        expiresAt - issuedAt !== ACCESS_TOKEN_TTL_SECONDS ||
        issuedAt > currentTime + ALLOWED_CLOCK_SKEW_SECONDS
      ) {
        throw unauthorized()
      }
      if (expiresAt <= currentTime) throw expired()
      return { sub: payload['sub'], sid: payload['sid'] }
    })
  }

  createRefreshToken(): { token: string; hash: Buffer } {
    const random = Buffer.from(this.#randomBytes(REFRESH_TOKEN_BYTES))
    if (random.length !== REFRESH_TOKEN_BYTES) {
      throw new Error('Refresh-token random source returned an invalid length')
    }
    const token = `rft_${random.toString('base64url')}`
    return { token, hash: refreshTokenHash(token) }
  }

  hashRefreshToken(token: string): Buffer {
    const match = REFRESH_TOKEN.exec(token)
    const encoded = match?.[1]
    if (encoded === undefined) throw invalidRefreshToken()
    const random = Buffer.from(encoded, 'base64url')
    if (random.length !== REFRESH_TOKEN_BYTES || random.toString('base64url') !== encoded) {
      throw invalidRefreshToken()
    }
    return refreshTokenHash(token)
  }
}
