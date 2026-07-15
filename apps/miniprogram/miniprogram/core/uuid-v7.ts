const UUID_BYTE_COUNT = 16
const MAX_TIMESTAMP = 2 ** 48 - 1

function hex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

/** Creates an RFC 9562 UUIDv7 suitable for API idempotency keys. */
export function createUuidV7(timestampMs: number, entropy: Uint8Array): string {
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > MAX_TIMESTAMP ||
    entropy.byteLength !== UUID_BYTE_COUNT
  ) {
    throw new RangeError('UUIDv7 input is invalid')
  }

  const bytes = entropy.slice()
  let timestamp = timestampMs
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256
    timestamp = Math.floor(timestamp / 256)
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)

  const encoded = Array.from(bytes, hex).join('')
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`
}
