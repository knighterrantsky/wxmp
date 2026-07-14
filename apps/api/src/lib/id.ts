import { randomBytes } from 'node:crypto'

import type { Clock } from './clock.js'
import { systemClock } from './clock.js'

export interface IdGenerator {
  next(): string
}

function uuidV7(clock: Clock): string {
  const timestamp = BigInt(clock.now().getTime())
  const random = randomBytes(10)
  const bytes = Buffer.allocUnsafe(16)

  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  bytes[6] = 0x70 | ((random[0] ?? 0) & 0x0f)
  bytes[7] = random[1] ?? 0
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f)
  random.copy(bytes, 9, 3)

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createSecureIdGenerator(clock: Clock = systemClock): IdGenerator {
  return { next: () => uuidV7(clock) }
}
