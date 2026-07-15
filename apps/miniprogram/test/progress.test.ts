import { describe, expect, it } from 'vitest'

import { UploadProgressTracker, calculateProgress } from '../miniprogram/core/progress.js'

describe('upload progress', () => {
  it('adds only bounded unconfirmed in-flight bytes to the authoritative baseline', () => {
    expect(calculateProgress(8, 16, [{ partNumber: 2, sentBytes: 4, expectedBytes: 8 }])).toEqual({
      bytes: 12,
      percent: 75,
    })

    expect(calculateProgress(8, 16, [{ partNumber: 2, sentBytes: 20, expectedBytes: 8 }])).toEqual({
      bytes: 16,
      percent: 100,
    })
  })

  it('does not double-count duplicate progress callbacks for the same part', () => {
    expect(
      calculateProgress(0, 16, [
        { partNumber: 1, sentBytes: 2, expectedBytes: 8 },
        { partNumber: 1, sentBytes: 6, expectedBytes: 8 },
      ]),
    ).toEqual({ bytes: 6, percent: 37.5 })
  })

  it('bounds bytes and rounds the displayed percentage to two decimals', () => {
    expect(calculateProgress(-5, 12, [])).toEqual({ bytes: 0, percent: 0 })
    expect(calculateProgress(4, 12, [])).toEqual({ bytes: 4, percent: 33.33 })
    expect(calculateProgress(99, 12, [])).toEqual({ bytes: 12, percent: 100 })
  })

  it('removes an acknowledged part before applying confirmed bytes', () => {
    const tracker = new UploadProgressTracker(16)
    tracker.startPart(2, 8)
    tracker.updatePart(2, 4)

    expect(tracker.snapshot()).toEqual({ bytes: 4, percent: 25 })
    expect(tracker.confirmPart(2, 8)).toEqual({ bytes: 8, percent: 50 })
  })

  it('remains monotonic when concurrent part responses arrive out of order', () => {
    const tracker = new UploadProgressTracker(16)
    tracker.startPart(1, 8)
    tracker.startPart(2, 8)
    tracker.updatePart(1, 8)
    tracker.updatePart(2, 8)

    expect(tracker.confirmPart(2, 16)).toEqual({ bytes: 16, percent: 100 })
    expect(tracker.confirmPart(1, 8)).toEqual({ bytes: 16, percent: 100 })
  })

  it('does not move the displayed value backwards while a failed part is retried', () => {
    const tracker = new UploadProgressTracker(16)
    tracker.startPart(1, 8)
    tracker.updatePart(1, 6)

    expect(tracker.discardPart(1)).toEqual({ bytes: 6, percent: 37.5 })
    tracker.startPart(1, 8)
    expect(tracker.updatePart(1, 2)).toEqual({ bytes: 6, percent: 37.5 })
    expect(tracker.updatePart(1, 7)).toEqual({ bytes: 7, percent: 43.75 })
  })

  it('re-establishes progress from the server and discards stale callbacks on resume', () => {
    const tracker = new UploadProgressTracker(16)
    tracker.startPart(2, 8)
    tracker.updatePart(2, 6)

    expect(tracker.resetFromServer(8)).toEqual({ bytes: 8, percent: 50 })
    expect(() => tracker.updatePart(2, 7)).toThrow('part 2 is not in flight')
  })

  it('rejects invalid totals and part progress rather than producing NaN', () => {
    expect(() => calculateProgress(0, 0, [])).toThrow(RangeError)
    expect(() =>
      calculateProgress(0, 12, [{ partNumber: 0, sentBytes: 1, expectedBytes: 2 }]),
    ).toThrow(RangeError)
    expect(() => new UploadProgressTracker(Number.NaN)).toThrow(RangeError)
  })
})
