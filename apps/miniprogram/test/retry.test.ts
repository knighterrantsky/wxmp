import { describe, expect, it, vi } from 'vitest'

import {
  MAX_UPLOAD_RETRIES,
  fullJitterDelayMs,
  retryWithFullJitter,
  shouldRetryUploadFailure,
} from '../miniprogram/core/retry.js'

describe('upload retry policy', () => {
  it.each([408, 429, 502, 503, 504])('retries documented HTTP status %i', (statusCode) => {
    expect(shouldRetryUploadFailure({ statusCode })).toBe(true)
  })

  it('retries network failures and explicitly retryable responses', () => {
    expect(shouldRetryUploadFailure({ networkError: true })).toBe(true)
    expect(shouldRetryUploadFailure({ statusCode: 409, retryable: true })).toBe(true)
    expect(shouldRetryUploadFailure({ statusCode: 500, retryable: true })).toBe(true)
  })

  it('does not retry ordinary business failures', () => {
    expect(shouldRetryUploadFailure({ statusCode: 400 })).toBe(false)
    expect(shouldRetryUploadFailure({ statusCode: 401 })).toBe(false)
    expect(shouldRetryUploadFailure({ statusCode: 409 })).toBe(false)
    expect(shouldRetryUploadFailure({ statusCode: 500 })).toBe(false)
    expect(shouldRetryUploadFailure(new Error('local validation failed'))).toBe(false)
  })

  it('uses full jitter with an exponential cap of 30 seconds', () => {
    expect(fullJitterDelayMs(0, () => 0)).toBe(0)
    expect(fullJitterDelayMs(0, () => 0.5)).toBe(500)
    expect(fullJitterDelayMs(1, () => 0.5)).toBe(1_000)
    expect(fullJitterDelayMs(10, () => 0.5)).toBe(15_000)
    expect(fullJitterDelayMs(10, () => 0.999)).toBeLessThan(30_000)
  })

  it('passes a zero-based attempt number and succeeds after retryable failures', async () => {
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce({ networkError: true })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValue('ok')
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined)

    await expect(retryWithFullJitter(operation, { sleep, random: () => 0.5 })).resolves.toBe('ok')
    expect(operation.mock.calls).toEqual([[0], [1], [2]])
    expect(sleep.mock.calls).toEqual([[500], [1_000]])
  })

  it('stops after five automatic retries and preserves the final failure', async () => {
    const finalFailure = Object.assign(new Error('last failure'), {
      statusCode: 503,
      marker: 'last failure',
    })
    let attempts = 0
    const operation = vi.fn(() => {
      attempts += 1
      if (attempts === MAX_UPLOAD_RETRIES + 1) return Promise.reject(finalFailure)
      return Promise.reject(
        Object.assign(new Error(`failure ${String(attempts)}`), { statusCode: 503 }),
      )
    })
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined)

    await expect(retryWithFullJitter(operation, { sleep, random: () => 0 })).rejects.toBe(
      finalFailure,
    )
    expect(operation).toHaveBeenCalledTimes(6)
    expect(sleep).toHaveBeenCalledTimes(5)
  })

  it('does not sleep or make a second attempt for a non-retryable failure', async () => {
    const failure = { statusCode: 415, retryable: false }
    const operation = vi.fn().mockRejectedValue(failure)
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined)

    await expect(retryWithFullJitter(operation, { sleep })).rejects.toBe(failure)
    expect(operation).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('rejects invalid retry indices instead of generating an unsafe delay', () => {
    expect(() => fullJitterDelayMs(-1)).toThrow(RangeError)
    expect(() => fullJitterDelayMs(0.5)).toThrow(RangeError)
  })
})
