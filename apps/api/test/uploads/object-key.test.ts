import { describe, expect, it } from 'vitest'

import { buildObjectKey } from '../../src/uploads/object-key.js'

const input = {
  userId: '019bfae0-7b1a-7c32-89fd-6dfb0ce51234',
  mediaId: '019bfae1-8c2b-7b21-98ce-7eac1df62345',
  kind: 'video' as const,
  extension: '.mp4',
  now: new Date('2026-07-14T00:00:00Z'),
}

describe('private object key', () => {
  it('uses only server-owned identifiers, UTC date, kind, and canonical extension', () => {
    expect(buildObjectKey(input)).toBe(
      'users/019bfae0-7b1a-7c32-89fd-6dfb0ce51234/video/2026/07/019bfae1-8c2b-7b21-98ce-7eac1df62345.mp4',
    )
  })

  it('uses UTC rather than the server timezone', () => {
    expect(buildObjectKey({ ...input, now: new Date('2027-01-01T00:00:00+08:00') })).toContain(
      '/2026/12/',
    )
  })

  it.each([
    { userId: '../owner' },
    { mediaId: '019bfae1/../../../escape' },
    { kind: 'avatar' },
    { extension: '../.html' },
    { extension: '.jpeg' },
    { now: new Date('invalid') },
  ])('rejects non-canonical server inputs %#', (override) => {
    expect(() => buildObjectKey({ ...input, ...override })).toThrow()
  })
})
