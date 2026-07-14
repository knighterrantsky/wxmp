import type { InitializeUploadRequest } from '@wx-upload/contracts'
import { describe, expect, it } from 'vitest'

import { validateMediaPolicy } from '../../src/uploads/media-policy.js'

function request(override: Partial<InitializeUploadRequest> = {}): InitializeUploadRequest {
  return {
    fileName: 'photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1_024,
    ...override,
  } as InitializeUploadRequest
}

describe('media initialization policy', () => {
  it.each([
    ['image/jpeg', 'photo.jpeg', '.jpg'],
    ['image/png', 'photo.PNG', '.png'],
    ['image/webp', 'photo.webp', '.webp'],
    ['image/gif', 'photo.gif', '.gif'],
    ['image/heic', 'photo.heic', '.heic'],
    ['image/heif', 'photo.heif', '.heif'],
  ] as const)('accepts the documented image pair %s', (mimeType, fileName, canonicalExtension) => {
    expect(validateMediaPolicy(request({ fileName, mimeType }))).toMatchObject({
      fileName,
      canonicalExtension,
    })
  })

  it.each([
    ['video/mp4', 'clip.mp4', '.mp4'],
    ['video/mp4', 'clip.m4v', '.mp4'],
    ['video/quicktime', 'clip.mov', '.mov'],
  ] as const)('accepts the documented video pair %s', (mimeType, fileName, canonicalExtension) => {
    expect(validateMediaPolicy(request({ kind: 'video', fileName, mimeType }))).toMatchObject({
      fileName,
      canonicalExtension,
    })
  })

  it('normalizes the display filename to Unicode NFC', () => {
    expect(validateMediaPolicy(request({ fileName: 'cafe\u0301.jpg' })).fileName).toBe(
      'caf\u00e9.jpg',
    )
  })

  it.each([
    '../photo.jpg',
    'folder/photo.jpg',
    'folder\\photo.jpg',
    '.',
    '..',
    'photo\u0000.jpg',
    'photo\u0085.jpg',
    '   ',
  ])('rejects unsafe display filename %j', (fileName) => {
    expect(() => validateMediaPolicy(request({ fileName }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 422 }),
    )
  })

  it('applies the 255-byte limit after NFC normalization', () => {
    expect(() => validateMediaPolicy(request({ fileName: `${'界'.repeat(84)}.jpg` }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })

  it.each([
    request({ mimeType: 'image/jpeg', fileName: 'photo.png' }),
    request({ kind: 'video', mimeType: 'video/mp4', fileName: 'clip.mov' }),
    request({ kind: 'image', mimeType: 'image/png', fileName: 'photo' }),
    request({ kind: 'image', mimeType: 'image/png', fileName: 'photo.svg' }),
  ])('rejects a MIME, kind, or extension outside the exact whitelist', (candidate) => {
    expect(() => validateMediaPolicy(candidate)).toThrow(
      expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED', statusCode: 415 }),
    )
  })

  it.each([
    [11, 'FILE_TOO_SMALL', 422],
    [209_715_201, 'FILE_TOO_LARGE', 413],
  ] as const)('rejects an invalid size %d', (sizeBytes, code, statusCode) => {
    expect(() => validateMediaPolicy(request({ sizeBytes }))).toThrow(
      expect.objectContaining({ code, statusCode }),
    )
  })

  it.each([12, 209_715_200])('accepts the inclusive file-size boundary %d', (sizeBytes) => {
    expect(validateMediaPolicy(request({ sizeBytes })).request.sizeBytes).toBe(sizeBytes)
  })

  it('rejects non-integer sizes and unpaired Unicode surrogates', () => {
    expect(() => validateMediaPolicy(request({ sizeBytes: 12.5 }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(() => validateMediaPolicy(request({ fileName: 'bad\ud800.jpg' }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })
})
