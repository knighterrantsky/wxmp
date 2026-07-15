const BLOCK_BYTES = 64
const LENGTH_BYTES = 8
const WORD_BYTES = 4

const INITIAL_STATE = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, distance: number): number {
  return ((value >>> distance) | (value << (32 - distance))) >>> 0
}

function readWord(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function writeWord(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24
  bytes[offset + 1] = value >>> 16
  bytes[offset + 2] = value >>> 8
  bytes[offset + 3] = value
}

function compress(
  state: Uint32Array,
  schedule: Uint32Array,
  bytes: Uint8Array,
  offset: number,
): void {
  for (let index = 0; index < 16; index += 1) {
    schedule[index] = readWord(bytes, offset + index * WORD_BYTES)
  }
  for (let index = 16; index < schedule.length; index += 1) {
    const previousTwo = schedule[index - 2] ?? 0
    const previousFifteen = schedule[index - 15] ?? 0
    const sigmaOne =
      rotateRight(previousTwo, 17) ^ rotateRight(previousTwo, 19) ^ (previousTwo >>> 10)
    const sigmaZero =
      rotateRight(previousFifteen, 7) ^ rotateRight(previousFifteen, 18) ^ (previousFifteen >>> 3)
    schedule[index] =
      (sigmaOne + (schedule[index - 7] ?? 0) + sigmaZero + (schedule[index - 16] ?? 0)) >>> 0
  }

  let a = state[0] ?? 0
  let b = state[1] ?? 0
  let c = state[2] ?? 0
  let d = state[3] ?? 0
  let e = state[4] ?? 0
  let f = state[5] ?? 0
  let g = state[6] ?? 0
  let h = state[7] ?? 0

  for (let index = 0; index < schedule.length; index += 1) {
    const sumOne = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
    const choice = (e & f) ^ (~e & g)
    const temporaryOne =
      (h + sumOne + choice + (ROUND_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) >>> 0
    const sumZero = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
    const majority = (a & b) ^ (a & c) ^ (b & c)
    const temporaryTwo = (sumZero + majority) >>> 0

    h = g
    g = f
    f = e
    e = (d + temporaryOne) >>> 0
    d = c
    c = b
    b = a
    a = (temporaryOne + temporaryTwo) >>> 0
  }

  state[0] = ((state[0] ?? 0) + a) >>> 0
  state[1] = ((state[1] ?? 0) + b) >>> 0
  state[2] = ((state[2] ?? 0) + c) >>> 0
  state[3] = ((state[3] ?? 0) + d) >>> 0
  state[4] = ((state[4] ?? 0) + e) >>> 0
  state[5] = ((state[5] ?? 0) + f) >>> 0
  state[6] = ((state[6] ?? 0) + g) >>> 0
  state[7] = ((state[7] ?? 0) + h) >>> 0
}

/** SHA-256 for a bounded in-memory chunk without BigInt or DataView BigInt64 methods. */
export function sha256Hex(input: Uint8Array): string {
  const state = Uint32Array.from(INITIAL_STATE)
  const schedule = new Uint32Array(64)
  const completeBytes = input.byteLength - (input.byteLength % BLOCK_BYTES)
  for (let offset = 0; offset < completeBytes; offset += BLOCK_BYTES) {
    compress(state, schedule, input, offset)
  }

  const remainder = input.byteLength - completeBytes
  const finalByteLength = remainder < BLOCK_BYTES - LENGTH_BYTES ? BLOCK_BYTES : BLOCK_BYTES * 2
  const finalBlocks = new Uint8Array(finalByteLength)
  finalBlocks.set(input.subarray(completeBytes), 0)
  finalBlocks[remainder] = 0x80

  const lowBitLength = (input.byteLength * 8) >>> 0
  const highBitLength = Math.floor(input.byteLength / 0x2000_0000) >>> 0
  writeWord(finalBlocks, finalByteLength - LENGTH_BYTES, highBitLength)
  writeWord(finalBlocks, finalByteLength - WORD_BYTES, lowBitLength)
  for (let offset = 0; offset < finalBlocks.byteLength; offset += BLOCK_BYTES) {
    compress(state, schedule, finalBlocks, offset)
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}
