import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  PUBLIC_UPLOAD_STATUSES,
  UUID_V7_PATTERN,
  type PublicUploadStatus,
} from '@wx-upload/contracts'

import { ApiError, PUBLIC_ERROR_MESSAGES } from '../http/errors.js'
import type { Clock } from '../lib/clock.js'

export const HISTORY_CURSOR_TTL_SECONDS = 24 * 60 * 60

const MAX_CURSOR_LENGTH = 4_096
const MAX_PAYLOAD_BYTES = 512
const HMAC_BYTES = 32
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const UUID_V7 = new RegExp(UUID_V7_PATTERN, 'u')
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const PUBLIC_STATUSES = new Set<string>(PUBLIC_UPLOAD_STATUSES)

export interface HistoryCursorFilter {
  readonly status: PublicUploadStatus | null
}

export interface HistoryCursorPosition {
  readonly createdAt: Date
  readonly id: string
}

export interface SignedHistoryCursorConfig {
  readonly secret: Buffer
  readonly clock: Clock
  readonly ttlSeconds?: number
}

export interface EncodeHistoryCursorInput extends HistoryCursorPosition {
  readonly userId: string
  readonly filter: HistoryCursorFilter
}

export interface DecodeHistoryCursorBinding {
  readonly userId: string
  readonly filter: HistoryCursorFilter
}

type JsonRecord = Readonly<Record<string, unknown>>

function invalidCursor(): ApiError {
  return new ApiError({
    code: 'INVALID_CURSOR',
    message: PUBLIC_ERROR_MESSAGES.INVALID_CURSOR,
    statusCode: 400,
  })
}

function validUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value)
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validFilter(value: unknown): value is HistoryCursorFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'status')) return false
  const status = record['status']
  return status === null || (typeof status === 'string' && PUBLIC_STATUSES.has(status))
}

function validBinding(value: DecodeHistoryCursorBinding): boolean {
  return validUuidV7(value.userId) && validFilter(value.filter)
}

function parseRecord(bytes: Buffer): JsonRecord {
  const value: unknown = JSON.parse(UTF8_DECODER.decode(bytes))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidCursor()
  return value as JsonRecord
}

function hasExactKeys(record: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

function decodeBase64Url(segment: string, maximumBytes: number): Buffer {
  if (!BASE64URL.test(segment)) throw invalidCursor()
  const decoded = Buffer.from(segment, 'base64url')
  if (
    decoded.length < 1 ||
    decoded.length > maximumBytes ||
    decoded.toString('base64url') !== segment
  ) {
    throw invalidCursor()
  }
  return decoded
}

function deriveKey(secret: Buffer, purpose: 'binding' | 'signature'): Buffer {
  return createHmac('sha256', secret)
    .update(`wx-private-media-upload:history-cursor:v1:${purpose}`, 'ascii')
    .digest()
}

export class SignedHistoryCursorCodec {
  readonly #clock: Clock
  readonly #ttlSeconds: number
  readonly #bindingKey: Buffer
  readonly #signatureKey: Buffer

  constructor(config: SignedHistoryCursorConfig) {
    if (!Buffer.isBuffer(config.secret) || config.secret.length < 32) {
      throw new Error('History cursor secret must contain at least 32 bytes')
    }
    const ttlSeconds = config.ttlSeconds ?? HISTORY_CURSOR_TTL_SECONDS
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
      throw new Error('History cursor TTL is invalid')
    }
    const secret = Buffer.from(config.secret)
    this.#clock = config.clock
    this.#ttlSeconds = ttlSeconds
    this.#bindingKey = deriveKey(secret, 'binding')
    this.#signatureKey = deriveKey(secret, 'signature')
    secret.fill(0)
  }

  encode(input: EncodeHistoryCursorInput): string {
    if (!validBinding(input)) throw new Error('History cursor binding is invalid')
    const createdAt = input.createdAt.getTime()
    if (!validEpoch(createdAt) || !validUuidV7(input.id)) {
      throw new Error('History cursor position is invalid')
    }
    const currentTime = this.#currentEpochSeconds()
    const expiresAt = currentTime + this.#ttlSeconds
    if (!Number.isSafeInteger(expiresAt)) throw new Error('History cursor clock is invalid')

    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        t: createdAt,
        i: input.id,
        e: expiresAt,
        b: this.#binding(input),
      }),
      'utf8',
    ).toString('base64url')
    const signature = this.#sign(payload).toString('base64url')
    return `${payload}.${signature}`
  }

  decode(cursor: string, binding: DecodeHistoryCursorBinding): HistoryCursorPosition {
    try {
      if (!validBinding(binding) || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
        throw invalidCursor()
      }
      const segments = cursor.split('.')
      if (segments.length !== 2) throw invalidCursor()
      const [encodedPayload, encodedSignature] = segments
      if (encodedPayload === undefined || encodedSignature === undefined) throw invalidCursor()

      const payloadBytes = decodeBase64Url(encodedPayload, MAX_PAYLOAD_BYTES)
      const suppliedSignature = decodeBase64Url(encodedSignature, HMAC_BYTES)
      if (suppliedSignature.length !== HMAC_BYTES) throw invalidCursor()
      const expectedSignature = this.#sign(encodedPayload)
      if (!timingSafeEqual(suppliedSignature, expectedSignature)) throw invalidCursor()

      const payload = parseRecord(payloadBytes)
      if (
        !hasExactKeys(payload, ['v', 't', 'i', 'e', 'b']) ||
        payload['v'] !== 1 ||
        !validEpoch(payload['t']) ||
        !validUuidV7(payload['i']) ||
        !validEpoch(payload['e']) ||
        typeof payload['b'] !== 'string'
      ) {
        throw invalidCursor()
      }

      const suppliedBinding = decodeBase64Url(payload['b'], HMAC_BYTES)
      const expectedBinding = Buffer.from(this.#binding(binding), 'base64url')
      if (
        suppliedBinding.length !== HMAC_BYTES ||
        !timingSafeEqual(suppliedBinding, expectedBinding) ||
        payload['e'] <= this.#currentEpochSeconds()
      ) {
        throw invalidCursor()
      }

      const createdAt = new Date(payload['t'])
      if (!Number.isFinite(createdAt.getTime())) throw invalidCursor()
      return { createdAt, id: payload['i'] }
    } catch {
      throw invalidCursor()
    }
  }

  #binding(binding: DecodeHistoryCursorBinding): string {
    return createHmac('sha256', this.#bindingKey)
      .update(
        JSON.stringify({
          userId: binding.userId,
          status: binding.filter.status,
        }),
        'utf8',
      )
      .digest('base64url')
  }

  #currentEpochSeconds(): number {
    const currentTime = Math.floor(this.#clock.now().getTime() / 1_000)
    if (!validEpoch(currentTime)) throw new Error('History cursor clock is invalid')
    return currentTime
  }

  #sign(encodedPayload: string): Buffer {
    return createHmac('sha256', this.#signatureKey).update(encodedPayload, 'ascii').digest()
  }
}
