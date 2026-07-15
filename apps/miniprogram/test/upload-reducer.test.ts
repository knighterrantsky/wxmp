import { describe, expect, it } from 'vitest'

import {
  InvalidUploadTransitionError,
  createUploadState,
  isTerminalUploadStatus,
  transitionUploadStatus,
  uploadReducer,
  type UploadLifecycleStatus,
} from '../miniprogram/core/upload-reducer.js'

function follow(path: readonly UploadLifecycleStatus[]): UploadLifecycleStatus {
  let state = createUploadState()
  for (const status of path) {
    state = uploadReducer(state, { type: 'transition', status })
  }
  return state.status
}

describe('upload lifecycle reducer', () => {
  it('supports the normal confirmed upload path', () => {
    expect(follow(['queued', 'initializing', 'uploading', 'finalizing', 'uploaded'])).toBe(
      'uploaded',
    )
  })

  it('supports cancellation before server creation without entering upload states', () => {
    expect(follow(['cancelled'])).toBe('cancelled')
    expect(follow(['queued', 'cancelled'])).toBe('cancelled')
  })

  it('supports pause/resume, finalizer repair, and durable cancellation outcomes', () => {
    expect(follow(['queued', 'initializing', 'uploading', 'paused', 'uploading'])).toBe('uploading')
    expect(follow(['queued', 'initializing', 'uploading', 'finalizing', 'uploading'])).toBe(
      'uploading',
    )
    expect(follow(['queued', 'initializing', 'uploading', 'cancelling', 'aborted'])).toBe('aborted')
    expect(follow(['queued', 'initializing', 'uploading', 'cancelling', 'expired'])).toBe('expired')
    expect(follow(['queued', 'initializing', 'uploading', 'cancelling', 'failed'])).toBe('failed')
  })

  it('treats a repeated observed status as an idempotent no-op', () => {
    const uploading = follow(['queued', 'initializing', 'uploading'])
    expect(transitionUploadStatus(uploading, 'uploading')).toBe('uploading')
  })

  it.each([
    ['selected', 'uploading'],
    ['queued', 'uploaded'],
    ['initializing', 'finalizing'],
    ['paused', 'finalizing'],
    ['uploaded', 'uploading'],
    ['failed', 'queued'],
    ['cancelled', 'queued'],
    ['aborted', 'uploading'],
    ['expired', 'uploading'],
  ] as const)('rejects illegal transition %s -> %s', (from, to) => {
    expect(() => transitionUploadStatus(from, to)).toThrow(InvalidUploadTransitionError)
    expect(() => transitionUploadStatus(from, to)).toThrow(`cannot transition ${from} -> ${to}`)
  })

  it.each(['uploaded', 'failed', 'cancelled', 'aborted', 'expired'] as const)(
    'marks %s as terminal',
    (status) => {
      expect(isTerminalUploadStatus(status)).toBe(true)
    },
  )

  it.each([
    'selected',
    'queued',
    'initializing',
    'uploading',
    'paused',
    'finalizing',
    'cancelling',
  ] as const)('marks %s as non-terminal', (status) => {
    expect(isTerminalUploadStatus(status)).toBe(false)
  })
})
