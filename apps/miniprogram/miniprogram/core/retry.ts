export const MAX_UPLOAD_RETRIES = 5
export const MAX_RETRY_DELAY_SECONDS = 30

export interface UploadFailureLike {
  readonly networkError?: boolean
  readonly statusCode?: number
  readonly retryable?: boolean
}

export interface RetryOptions {
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
  readonly random?: (() => number) | undefined
  readonly shouldRetry?: ((error: unknown) => boolean) | undefined
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504])

function failureLike(error: unknown): UploadFailureLike | null {
  if (typeof error !== 'object' || error === null) return null
  return error
}

export function shouldRetryUploadFailure(error: unknown): boolean {
  const failure = failureLike(error)
  if (failure === null) return false
  if (failure.networkError === true || failure.retryable === true) return true
  return failure.statusCode !== undefined && RETRYABLE_STATUS_CODES.has(failure.statusCode)
}

export function fullJitterDelayMs(retryIndex: number, random: () => number = Math.random): number {
  if (!Number.isSafeInteger(retryIndex) || retryIndex < 0) {
    throw new RangeError('retryIndex must be a non-negative safe integer')
  }
  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('random must return a number in [0, 1)')
  }
  const capSeconds = Math.min(2 ** retryIndex, MAX_RETRY_DELAY_SECONDS)
  return Math.floor(sample * capSeconds * 1_000)
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

/** Runs the initial request plus at most five automatic network retries. */
export async function retryWithFullJitter<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const shouldRetry = options.shouldRetry ?? shouldRetryUploadFailure

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt >= MAX_UPLOAD_RETRIES || !shouldRetry(error)) throw error
      await sleep(fullJitterDelayMs(attempt, random))
    }
  }
}
