import type { UploadDetailResponse } from '@wx-upload/contracts'
import { describe, expect, it } from 'vitest'

import {
  decideResume,
  planColdResume,
  planForegroundResume,
  selectPendingParts,
  type ResumeServerPart,
} from '../miniprogram/core/resume.js'

type DetailPart = UploadDetailResponse['data']['parts'][number]

const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)
const hashC = 'c'.repeat(64)

function part(
  partNumber: number,
  status: DetailPart['status'],
  sha256: string | null = status === 'pending' ? null : hashA,
): ResumeServerPart {
  return {
    partNumber,
    offsetBytes: (partNumber - 1) * 8_388_608,
    sizeBytes: partNumber === 3 ? 123 : 8_388_608,
    status,
    sha256,
  }
}

describe('foreground resume', () => {
  it('selects only server-pending parts in part-number order', () => {
    const serverParts = [
      part(3, 'pending'),
      part(1, 'uploaded', hashA),
      part(4, 'verified', hashC),
      part(2, 'pending'),
    ]

    expect(selectPendingParts(serverParts)).toEqual([part(2, 'pending'), part(3, 'pending')])
  })

  it('uses the server as the foreground source of truth', () => {
    const serverParts = [part(1, 'verified', hashA), part(2, 'pending')]

    expect(planForegroundResume(serverParts)).toEqual({
      action: 'resume',
      pendingParts: [part(2, 'pending')],
    })
  })

  it('does not mutate server part input or expose its object references', () => {
    const first = Object.freeze(part(2, 'pending'))
    const second = Object.freeze(part(1, 'uploaded', hashA))
    const serverParts = Object.freeze([first, second])
    const before = JSON.stringify(serverParts)

    const selected = selectPendingParts(serverParts)
    const selectedPart = selected[0]
    const originalPart = serverParts[0]
    if (selectedPart === undefined || originalPart === undefined)
      throw new Error('missing fixture part')
    selectedPart.offsetBytes = 99

    expect(JSON.stringify(serverParts)).toBe(before)
    expect(originalPart.offsetBytes).not.toBe(99)
  })
})

describe('cold resume decision', () => {
  it('resumes when every remotely confirmed hash matches the local source', () => {
    const input = {
      pathReadable: true,
      localHashes: Object.freeze({ 1: hashA, 3: hashC }),
      remoteHashes: Object.freeze({ 1: hashA, 3: hashC }),
    } as const

    expect(decideResume(input)).toBe('resume')
  })

  it('replaces when the original path is unreadable', () => {
    expect(
      decideResume({
        pathReadable: false,
        localHashes: { 1: hashA },
        remoteHashes: { 1: hashA },
      }),
    ).toBe('replace')
  })

  it('replaces when a remotely confirmed part has no local hash', () => {
    expect(
      decideResume({
        pathReadable: true,
        localHashes: { 1: hashA },
        remoteHashes: { 1: hashA, 2: hashB },
      }),
    ).toBe('replace')
  })

  it('does not accept an inherited value as a locally computed part hash', () => {
    const localHashes = Object.create({ 1: hashA }) as Record<number, string>

    expect(decideResume({ pathReadable: true, localHashes, remoteHashes: { 1: hashA } })).toBe(
      'replace',
    )
  })

  it('replaces when any remotely confirmed hash differs exactly', () => {
    expect(
      decideResume({
        pathReadable: true,
        localHashes: { 1: hashA, 2: hashA },
        remoteHashes: { 1: hashA, 2: hashB },
      }),
    ).toBe('replace')
  })

  it('replaces when the server lacks a usable hash for a confirmed part', () => {
    expect(
      decideResume({
        pathReadable: true,
        localHashes: { 1: hashA },
        remoteHashes: { 1: null },
      }),
    ).toBe('replace')
  })

  it('allows an empty remote confirmed set when the path is readable', () => {
    expect(decideResume({ pathReadable: true, localHashes: {}, remoteHashes: {} })).toBe('resume')
  })

  it('ignores additional local hashes that the server has not confirmed', () => {
    expect(
      decideResume({
        pathReadable: true,
        localHashes: { 1: hashA, 2: hashB, 25: hashC },
        remoteHashes: { 1: hashA },
      }),
    ).toBe('resume')
  })

  it('builds a runner-ready resume plan from confirmed and pending server parts', () => {
    const serverParts = [part(3, 'pending'), part(1, 'uploaded', hashA), part(2, 'verified', hashB)]

    expect(
      planColdResume({
        pathReadable: true,
        localHashes: { 1: hashA, 2: hashB, 3: hashC },
        serverParts,
      }),
    ).toEqual({ action: 'resume', pendingParts: [part(3, 'pending')] })
  })

  it('requires abort-and-replace without returning pending work after a mismatch', () => {
    expect(
      planColdResume({
        pathReadable: true,
        localHashes: { 1: hashB, 2: hashC },
        serverParts: [part(1, 'uploaded', hashA), part(2, 'pending')],
      }),
    ).toEqual({ action: 'replace', abortReason: 'replaced', pendingParts: [] })
  })

  it('does not mutate local hash or server part inputs', () => {
    const localHashes = Object.freeze({ 1: hashA, 2: hashB })
    const serverParts = Object.freeze([
      Object.freeze(part(2, 'pending')),
      Object.freeze(part(1, 'uploaded', hashA)),
    ])
    const before = JSON.stringify({ localHashes, serverParts })

    planColdResume({ pathReadable: true, localHashes, serverParts })

    expect(JSON.stringify({ localHashes, serverParts })).toBe(before)
  })
})
