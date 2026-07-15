import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../miniprogram/core/sha256.js'

function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_value, index) => (index * 31 + 17) & 0xff)
}

function expectedSha256(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

describe('WeChat-compatible SHA-256', () => {
  it.each([0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 129, 1_024, 1_048_576, 8_388_608])(
    'matches the standard digest across the %i-byte padding boundary',
    (size) => {
      const input = bytes(size)

      expect(sha256Hex(input)).toBe(expectedSha256(input))
    },
  )

  it('does not require BigInt or DataView BigInt64 methods', () => {
    const setBigUint64 = Object.getOwnPropertyDescriptor(DataView.prototype, 'setBigUint64')
    const globalBigInt = Object.getOwnPropertyDescriptor(globalThis, 'BigInt')
    Object.defineProperty(DataView.prototype, 'setBigUint64', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(globalThis, 'BigInt', { configurable: true, value: undefined })
    try {
      expect(sha256Hex(Uint8Array.from([0x61, 0x62, 0x63]))).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      )
    } finally {
      if (setBigUint64 === undefined) {
        Reflect.deleteProperty(DataView.prototype, 'setBigUint64')
      } else {
        Object.defineProperty(DataView.prototype, 'setBigUint64', setBigUint64)
      }
      if (globalBigInt === undefined) {
        Reflect.deleteProperty(globalThis, 'BigInt')
      } else {
        Object.defineProperty(globalThis, 'BigInt', globalBigInt)
      }
    }
  })
})
