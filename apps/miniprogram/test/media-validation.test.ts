import { MAX_FILE_SIZE_BYTES, MAX_SELECTION_COUNT, MIN_FILE_SIZE_BYTES } from '@wx-upload/contracts'
import { describe, expect, it } from 'vitest'

import {
  MediaValidationError,
  canSchedulePart,
  validateMediaSelection,
  type MediaSelectionCandidate,
} from '../miniprogram/core/media-validation.js'

function candidate(overrides: Partial<MediaSelectionCandidate> = {}): MediaSelectionCandidate {
  return {
    sourcePath: '/tmp/photo.jpg',
    fileName: 'photo.jpg',
    sizeBytes: MIN_FILE_SIZE_BYTES,
    kind: 'image',
    mimeType: 'image/jpeg',
    readable: true,
    ...overrides,
  }
}

function expectValidationCode(run: () => unknown, code: string): void {
  try {
    run()
    throw new Error('expected media validation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(MediaValidationError)
    expect(error).toMatchObject({ code })
  }
}

describe('media selection validation', () => {
  it('accepts nine files and rejects a tenth file before creating uploads', () => {
    const nine = Array.from({ length: MAX_SELECTION_COUNT }, (_, index) =>
      candidate({
        sourcePath: `/tmp/${String(index)}.jpg`,
        fileName: `${String(index)}.jpg`,
      }),
    )

    expect(validateMediaSelection(nine)).toHaveLength(9)
    expectValidationCode(
      () => validateMediaSelection([...nine, candidate({ fileName: 'ten.jpg' })]),
      'SELECTION_LIMIT_EXCEEDED',
    )
  })

  it('enforces the exact 12-byte through 200-MiB size range', () => {
    expectValidationCode(
      () => validateMediaSelection([candidate({ sizeBytes: 11 })]),
      'FILE_TOO_SMALL',
    )
    expect(validateMediaSelection([candidate({ sizeBytes: 12 })])[0]?.sizeBytes).toBe(12)
    expect(
      validateMediaSelection([candidate({ sizeBytes: MAX_FILE_SIZE_BYTES })])[0]?.sizeBytes,
    ).toBe(209_715_200)
    expectValidationCode(
      () => validateMediaSelection([candidate({ sizeBytes: MAX_FILE_SIZE_BYTES + 1 })]),
      'FILE_TOO_LARGE',
    )
  })

  it.each([
    ['image', '/tmp/a.jpg', 'image/jpeg'],
    ['image', '/tmp/a.jpeg', 'image/jpeg'],
    ['image', '/tmp/a.png', 'image/png'],
    ['image', '/tmp/a.webp', 'image/webp'],
    ['image', '/tmp/a.gif', 'image/gif'],
    ['image', '/tmp/a.heic', 'image/heic'],
    ['image', '/tmp/a.heif', 'image/heif'],
    ['video', '/tmp/a.mp4', 'video/mp4'],
    ['video', '/tmp/a.m4v', 'video/mp4'],
    ['video', '/tmp/a.mov', 'video/quicktime'],
  ] as const)(
    'accepts and derives the documented %s declaration for %s',
    (kind, sourcePath, mimeType) => {
      const result = validateMediaSelection([
        candidate({ kind, sourcePath, fileName: undefined, mimeType: undefined }),
      ])[0]

      expect(result).toMatchObject({ kind, sourcePath, mimeType })
      expect(result?.fileName).toBe(sourcePath.slice('/tmp/'.length))
    },
  )

  it('uses a safe source basename and extension when WeChat omits a reliable name and MIME', () => {
    expect(
      validateMediaSelection([
        candidate({
          sourcePath: 'wxfile://tmp/path/holiday.PNG',
          fileName: '',
          mimeType: undefined,
        }),
      ])[0],
    ).toEqual({
      sourcePath: 'wxfile://tmp/path/holiday.PNG',
      fileName: 'holiday.PNG',
      sizeBytes: MIN_FILE_SIZE_BYTES,
      kind: 'image',
      mimeType: 'image/png',
    })
  })

  it.each([
    [
      candidate({ sourcePath: '/tmp/a.svg', fileName: 'a.svg', mimeType: undefined }),
      'UNSUPPORTED_MEDIA_TYPE',
    ],
    [
      candidate({ sourcePath: '/tmp/a.png', fileName: 'a.png', mimeType: 'image/jpeg' }),
      'MIME_EXTENSION_MISMATCH',
    ],
    [
      candidate({
        sourcePath: '/tmp/a.mp4',
        fileName: 'a.mp4',
        kind: 'image',
        mimeType: undefined,
      }),
      'KIND_MISMATCH',
    ],
    [
      candidate({ sourcePath: '/tmp/a.jpg', fileName: 'a.jpg', readable: false }),
      'FILE_UNREADABLE',
    ],
  ] as const)('rejects an unsafe declaration with code %s', (input, code) => {
    expectValidationCode(() => validateMediaSelection([input]), code)
  })

  it('rejects empty selections and non-integral or non-finite sizes', () => {
    expectValidationCode(() => validateMediaSelection([]), 'SELECTION_EMPTY')
    for (const sizeBytes of [12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectValidationCode(
        () => validateMediaSelection([candidate({ sizeBytes })]),
        'INVALID_FILE_SIZE',
      )
    }
  })

  it('rejects the same local source path twice so progress cannot update the wrong row', () => {
    expectValidationCode(
      () => validateMediaSelection([candidate(), candidate({ fileName: 'duplicate.jpg' })]),
      'DUPLICATE_SOURCE_PATH',
    )
  })

  it.each([
    [1, 'pending', true],
    [2, 'pending', false],
    [1, 'accepted', true],
    [2, 'accepted', true],
    [1, 'rejected', false],
    [2, 'rejected', false],
  ] as const)(
    'schedules part %i when first-part signature status is %s: %s',
    (partNumber, signatureStatus, expected) => {
      expect(canSchedulePart(partNumber, signatureStatus)).toBe(expected)
    },
  )
})
