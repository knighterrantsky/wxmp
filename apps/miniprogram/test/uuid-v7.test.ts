import { describe, expect, it } from 'vitest'

import { createUuidV7 } from '../miniprogram/core/uuid-v7.js'

describe('UUIDv7 idempotency keys', () => {
  it('encodes the millisecond timestamp, version, and RFC variant', () => {
    const uuid = createUuidV7(
      1_721_000_000_123,
      Uint8Array.from({ length: 16 }, (_, i) => i),
    )

    expect(uuid).toBe('0190b397-fa7b-7607-8809-0a0b0c0d0e0f')
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  })

  it('does not mutate caller randomness', () => {
    const random = new Uint8Array(16).fill(0xff)
    const before = random.slice()

    createUuidV7(0, random)

    expect(random).toEqual(before)
  })

  it.each([
    [-1, new Uint8Array(16)],
    [Number.NaN, new Uint8Array(16)],
    [2 ** 48, new Uint8Array(16)],
    [0, new Uint8Array(15)],
  ])('rejects invalid timestamp or entropy', (timestamp, random) => {
    expect(() => createUuidV7(timestamp, random)).toThrow(RangeError)
  })
})
