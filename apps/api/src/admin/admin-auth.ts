import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

import type { Clock } from '../lib/clock.js'

const VERIFIER_PATTERN = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/u
const SESSION_VERSION = 1
const SESSION_TTL_SECONDS = 8 * 60 * 60
const SESSION_TOKEN_MAX_LENGTH = 2_048

interface ParsedPasswordVerifier {
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
  readonly salt: Buffer
  readonly digest: Buffer
}

interface AdminSessionPayload {
  readonly version: 1
  readonly username: string
  readonly expiresAtSeconds: number
  readonly nonce: string
}

export interface AdminAuthConfig {
  readonly username: string
  readonly passwordVerifier: string
  readonly sessionSecret: Buffer
}

function digestText(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (value === '') return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? decoded : undefined
}

export function parseAdminPasswordVerifier(value: string): ParsedPasswordVerifier | undefined {
  const matched = VERIFIER_PATTERN.exec(value)
  if (matched === null) return undefined
  const cost = Number(matched[1])
  const blockSize = Number(matched[2])
  const parallelization = Number(matched[3])
  const salt = decodeCanonicalBase64Url(matched[4] ?? '')
  const digest = decodeCanonicalBase64Url(matched[5] ?? '')
  if (
    !Number.isSafeInteger(cost) ||
    cost < 16_384 ||
    cost > 262_144 ||
    (cost & (cost - 1)) !== 0 ||
    blockSize !== 8 ||
    parallelization !== 1 ||
    salt?.length === undefined ||
    salt.length < 16 ||
    digest?.length === undefined ||
    digest.length !== 32
  ) {
    return undefined
  }
  return { cost, blockSize, parallelization, salt, digest }
}

function derivePassword(
  password: string,
  verifier: Pick<ParsedPasswordVerifier, 'cost' | 'blockSize' | 'parallelization' | 'salt'>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      verifier.salt,
      32,
      {
        N: verifier.cost,
        r: verifier.blockSize,
        p: verifier.parallelization,
        maxmem: Math.max(64 * 1024 * 1024, 256 * verifier.cost * verifier.blockSize),
      },
      (error, derivedKey) => {
        if (error === null) resolve(derivedKey)
        else reject(error)
      },
    )
  })
}

export async function createAdminPasswordVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
): Promise<string> {
  if (password.length < 8 || password.length > 128 || salt.length < 16) {
    throw new RangeError('admin password or salt length is invalid')
  }
  const parameters = { cost: 16_384, blockSize: 8, parallelization: 1, salt }
  const digest = await derivePassword(password, parameters)
  return `scrypt:${String(parameters.cost)}:${String(parameters.blockSize)}:${String(parameters.parallelization)}:${salt.toString('base64url')}:${digest.toString('base64url')}`
}

function parseSessionPayload(encoded: string): AdminSessionPayload | undefined {
  const decoded = decodeCanonicalBase64Url(encoded)
  if (decoded === undefined || decoded.length > 512) return undefined
  try {
    const value: unknown = JSON.parse(decoded.toString('utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const version: unknown = Reflect.get(value, 'version')
    const username: unknown = Reflect.get(value, 'username')
    const expiresAtSeconds: unknown = Reflect.get(value, 'expiresAtSeconds')
    const nonce: unknown = Reflect.get(value, 'nonce')
    if (
      version !== SESSION_VERSION ||
      typeof username !== 'string' ||
      username.length < 1 ||
      username.length > 64 ||
      !Number.isSafeInteger(expiresAtSeconds) ||
      Number(expiresAtSeconds) < 0 ||
      typeof nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/u.test(nonce)
    ) {
      return undefined
    }
    return {
      version,
      username,
      expiresAtSeconds: Number(expiresAtSeconds),
      nonce,
    }
  } catch {
    return undefined
  }
}

export class AdminAuthService {
  readonly #username: string
  readonly #passwordVerifier: ParsedPasswordVerifier
  readonly #sessionSecret: Buffer
  readonly #clock: Clock

  constructor(config: AdminAuthConfig & { clock: Clock }) {
    const passwordVerifier = parseAdminPasswordVerifier(config.passwordVerifier)
    if (passwordVerifier === undefined || config.sessionSecret.length < 32) {
      throw new Error('invalid admin authentication configuration')
    }
    this.#username = config.username
    this.#passwordVerifier = passwordVerifier
    this.#sessionSecret = Buffer.from(config.sessionSecret)
    this.#clock = config.clock
  }

  get username(): string {
    return this.#username
  }

  async verifyCredentials(username: string, password: string): Promise<boolean> {
    const derived = await derivePassword(password, this.#passwordVerifier)
    return (
      timingSafeEqual(digestText(username), digestText(this.#username)) &&
      timingSafeEqual(derived, this.#passwordVerifier.digest)
    )
  }

  createSessionToken(): string {
    const expiresAtSeconds = Math.floor(this.#clock.now().getTime() / 1_000) + SESSION_TTL_SECONDS
    const payload = Buffer.from(
      JSON.stringify({
        version: SESSION_VERSION,
        username: this.#username,
        expiresAtSeconds,
        nonce: randomBytes(16).toString('base64url'),
      } satisfies AdminSessionPayload),
      'utf8',
    ).toString('base64url')
    const signature = createHmac('sha256', this.#sessionSecret).update(payload, 'utf8').digest()
    return `${payload}.${signature.toString('base64url')}`
  }

  verifySessionToken(token: string | undefined): boolean {
    if (token === undefined || token.length > SESSION_TOKEN_MAX_LENGTH) return false
    const pieces = token.split('.')
    if (pieces.length !== 2) return false
    const payload = pieces[0]
    const suppliedSignature = decodeCanonicalBase64Url(pieces[1] ?? '')
    if (payload === undefined || suppliedSignature?.length !== 32) {
      return false
    }
    const expectedSignature = createHmac('sha256', this.#sessionSecret)
      .update(payload, 'utf8')
      .digest()
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) return false
    const parsed = parseSessionPayload(payload)
    if (parsed?.username !== this.#username) return false
    return parsed.expiresAtSeconds > Math.floor(this.#clock.now().getTime() / 1_000)
  }
}

export const ADMIN_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS
