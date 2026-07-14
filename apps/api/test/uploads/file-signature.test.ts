import type { AllowedMimeType } from '@wx-upload/contracts'
import { describe, expect, it } from 'vitest'

import {
  FILE_SIGNATURE_PREFIX_BYTES,
  validateFileSignature,
  type CanonicalMediaExtension,
} from '../../src/uploads/file-signature.js'

interface Declaration {
  mimeType: AllowedMimeType
  canonicalExtension: CanonicalMediaExtension
}

const declaration = {
  jpeg: { mimeType: 'image/jpeg', canonicalExtension: '.jpg' },
  png: { mimeType: 'image/png', canonicalExtension: '.png' },
  webp: { mimeType: 'image/webp', canonicalExtension: '.webp' },
  gif: { mimeType: 'image/gif', canonicalExtension: '.gif' },
  heic: { mimeType: 'image/heic', canonicalExtension: '.heic' },
  heif: { mimeType: 'image/heif', canonicalExtension: '.heif' },
  mp4: { mimeType: 'video/mp4', canonicalExtension: '.mp4' },
  mov: { mimeType: 'video/quicktime', canonicalExtension: '.mov' },
} as const satisfies Record<string, Declaration>

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const webp = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
])
const gif87a = Buffer.from('GIF87a\u0001\u0000\u0001\u0000\u0000\u0000\u0000', 'binary')
const gif89a = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000', 'binary')

function ftyp(majorBrand: string, compatibleBrands: readonly string[]): Buffer {
  const size = 16 + compatibleBrands.length * 4
  const header = Buffer.alloc(16)
  header.writeUInt32BE(size, 0)
  header.write('ftyp', 4, 'ascii')
  header.write(majorBrand, 8, 'ascii')
  return Buffer.concat([header, ...compatibleBrands.map((brand) => Buffer.from(brand, 'ascii'))])
}

describe('file signature validation', () => {
  it('exports a small bounded prefix size for first-part streaming inspection', () => {
    expect(FILE_SIGNATURE_PREFIX_BYTES).toBeGreaterThanOrEqual(32)
    expect(FILE_SIGNATURE_PREFIX_BYTES).toBeLessThanOrEqual(512)
  })

  it.each([
    ['JPEG', jpeg, declaration.jpeg],
    ['PNG', png, declaration.png],
    ['WebP', webp, declaration.webp],
    ['GIF87a', gif87a, declaration.gif],
    ['GIF89a', gif89a, declaration.gif],
  ] as const)(
    'accepts a supported %s signature and exact declaration',
    (_name, prefix, expected) => {
      expect(validateFileSignature(prefix, expected)).toEqual({ ok: true })
    },
  )

  it.each(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'] as const)(
    'accepts HEIC brand %s in either the major or compatible position',
    (brand) => {
      const majorPrefix = ftyp(brand, [])
      const compatiblePrefix = ftyp('mif1', ['mif1', brand])

      expect(validateFileSignature(majorPrefix, declaration.heic)).toEqual({ ok: true })
      expect(validateFileSignature(compatiblePrefix, declaration.heic)).toEqual({ ok: true })
    },
  )

  it('accepts HEIF when mif1 is the major or a compatible brand', () => {
    expect(validateFileSignature(ftyp('mif1', []), declaration.heif)).toEqual({ ok: true })
    expect(validateFileSignature(ftyp('mif1', ['mif1']), declaration.heif)).toEqual({ ok: true })
  })

  it.each(['isom', 'iso2', 'avc1', 'hvc1', 'hev1', 'mp41', 'mp42', 'M4V '] as const)(
    'accepts MP4 brand %s in either the major or compatible position',
    (brand) => {
      expect(validateFileSignature(ftyp(brand, []), declaration.mp4)).toEqual({ ok: true })
      expect(validateFileSignature(ftyp('isom', ['isom', brand]), declaration.mp4)).toEqual({
        ok: true,
      })
    },
  )

  it('accepts QuickTime when qt is the major or a compatible brand', () => {
    expect(validateFileSignature(ftyp('qt  ', []), declaration.mov)).toEqual({ ok: true })
    expect(validateFileSignature(ftyp('qt  ', ['qt  ']), declaration.mov)).toEqual({ ok: true })
  })

  it('uses both the major and compatible brands for HEIC and HEIF declarations', () => {
    const heifOnly = ftyp('heic', ['mif1'])
    const heicOnly = ftyp('mif1', ['heic'])

    expect(validateFileSignature(heifOnly, declaration.heif)).toEqual({ ok: true })
    expect(validateFileSignature(heifOnly, declaration.heic)).toEqual({ ok: true })
    expect(validateFileSignature(heicOnly, declaration.heic)).toEqual({ ok: true })
    expect(validateFileSignature(heicOnly, declaration.heif)).toEqual({ ok: true })
  })

  it.each([
    [jpeg, declaration.png],
    [png, declaration.jpeg],
    [ftyp('mif1', ['mif1']), declaration.heic],
    [ftyp('heic', ['heic']), declaration.heif],
    [ftyp('isom', ['isom', 'mp42']), declaration.mov],
    [ftyp('qt  ', ['qt  ']), declaration.mp4],
  ] as const)('rejects a signature whose declared MIME is different', (prefix, expected) => {
    expect(validateFileSignature(prefix, expected)).toEqual({
      ok: false,
      reason: 'DECLARATION_MISMATCH',
    })
  })

  it.each([
    [jpeg, { mimeType: 'image/jpeg', canonicalExtension: '.png' }],
    [jpeg, { mimeType: 'image/jpeg', canonicalExtension: '.jpeg' }],
    [ftyp('isom', ['isom', 'mp42']), { mimeType: 'video/mp4', canonicalExtension: '.mov' }],
  ] as const)(
    'rejects a correct MIME paired with the wrong canonical extension',
    (prefix, expected) => {
      expect(validateFileSignature(prefix, expected)).toEqual({
        ok: false,
        reason: 'DECLARATION_MISMATCH',
      })
    },
  )

  it.each([
    ['JPEG', jpeg.subarray(0, 2), declaration.jpeg],
    ['PNG', png.subarray(0, 7), declaration.png],
    ['WebP', webp.subarray(0, 15), declaration.webp],
    ['GIF', gif89a.subarray(0, 5), declaration.gif],
    ['HEIC', ftyp('mif1', ['mif1', 'heic']).subarray(0, 19), declaration.heic],
    ['HEIF', ftyp('mif1', ['mif1']).subarray(0, 19), declaration.heif],
    ['MP4', ftyp('isom', ['mp42']).subarray(0, 19), declaration.mp4],
    ['MOV', ftyp('qt  ', ['qt  ']).subarray(0, 19), declaration.mov],
  ] as const)('rejects a truncated %s signature', (_name, prefix, expected) => {
    expect(validateFileSignature(prefix, expected)).toEqual({
      ok: false,
      reason: 'TRUNCATED',
    })
  })

  it.each([
    ['SVG', Buffer.from('<svg><script>alert(1)</script></svg>')],
    ['HTML', Buffer.from('<!doctype html><html></html>')],
    ['Windows executable', Buffer.from('4d5a90000300000004000000ffff0000', 'hex')],
    ['RIFF/WAVE', Buffer.from('RIFF\u0010\u0000\u0000\u0000WAVEfmt ', 'binary')],
    ['generic unsupported ISO-BMFF', ftyp('avif', ['avif'])],
    ['short random binary', Buffer.from('abcd', 'ascii')],
  ])('rejects %s content without exposing its bytes', (_name, prefix) => {
    const result = validateFileSignature(prefix, declaration.jpeg)

    expect(result).toEqual({ ok: false, reason: 'UNRECOGNIZED' })
    expect(JSON.stringify(result)).not.toContain(prefix.toString('hex'))
  })

  it('rejects malformed ftyp box lengths and partial compatible-brand entries', () => {
    const tooSmall = ftyp('isom', ['mp42'])
    tooSmall.writeUInt32BE(15, 0)
    const misaligned = ftyp('isom', ['mp42'])
    misaligned.writeUInt32BE(21, 0)

    expect(validateFileSignature(tooSmall, declaration.mp4)).toEqual({
      ok: false,
      reason: 'UNRECOGNIZED',
    })
    expect(validateFileSignature(misaligned, declaration.mp4)).toEqual({
      ok: false,
      reason: 'UNRECOGNIZED',
    })
  })

  it('rejects a short ftyp prefix whose declared box extends beyond the available file', () => {
    const truncated = ftyp('isom', [])
    truncated.writeUInt32BE(FILE_SIGNATURE_PREFIX_BYTES + 44, 0)

    expect(validateFileSignature(truncated, declaration.mp4)).toEqual({
      ok: false,
      reason: 'TRUNCATED',
    })
  })

  it('rejects an ftyp box larger than the total file even when the captured prefix is full', () => {
    const prefix = Buffer.alloc(FILE_SIGNATURE_PREFIX_BYTES)
    prefix.writeUInt32BE(1_000, 0)
    prefix.write('ftyp', 4, 'ascii')
    prefix.write('isom', 8, 'ascii')

    expect(validateFileSignature(prefix, declaration.mp4, 300)).toEqual({
      ok: false,
      reason: 'TRUNCATED',
    })
    expect(validateFileSignature(prefix, declaration.mp4, 1_000)).toEqual({ ok: true })
  })
})
