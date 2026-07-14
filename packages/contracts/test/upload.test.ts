import { describe, expect, it } from 'vitest'

import {
  MAX_FILE_SIZE_BYTES,
  MIN_FILE_SIZE_BYTES,
  PART_SIZE_BYTES,
  planUploadParts,
} from '../src/upload.js'

describe('planUploadParts', () => {
  it('splits 8 MiB plus one byte into two exact parts', () => {
    expect(planUploadParts(PART_SIZE_BYTES + 1)).toEqual([
      { partNumber: 1, offsetBytes: 0, sizeBytes: PART_SIZE_BYTES },
      { partNumber: 2, offsetBytes: PART_SIZE_BYTES, sizeBytes: 1 },
    ])
  })

  it('plans the minimum file as one part', () => {
    expect(planUploadParts(MIN_FILE_SIZE_BYTES)).toEqual([
      { partNumber: 1, offsetBytes: 0, sizeBytes: MIN_FILE_SIZE_BYTES },
    ])
  })

  it('plans a 200 MiB file as 25 exact parts', () => {
    const parts = planUploadParts(MAX_FILE_SIZE_BYTES)

    expect(parts).toHaveLength(25)
    expect(parts.at(-1)).toEqual({
      partNumber: 25,
      offsetBytes: MAX_FILE_SIZE_BYTES - PART_SIZE_BYTES,
      sizeBytes: PART_SIZE_BYTES,
    })
  })

  it.each([11, 209_715_201, 12.5, Number.NaN])('rejects an invalid file size: %s', (sizeBytes) => {
    expect(() => planUploadParts(sizeBytes)).toThrow(/file size/i)
  })
})
