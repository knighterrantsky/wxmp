export interface InFlightPartProgress {
  readonly partNumber: number
  readonly sentBytes: number
  readonly expectedBytes: number
}

export interface UploadProgress {
  readonly bytes: number
  readonly percent: number
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`)
}

function boundedBytes(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, value))
}

function roundedPercent(bytes: number, totalBytes: number): number {
  return Math.min(100, Math.round((bytes / totalBytes) * 10_000) / 100)
}

export function calculateProgress(
  confirmedBytes: number,
  totalBytes: number,
  inFlight: readonly InFlightPartProgress[],
): UploadProgress {
  assertPositiveSafeInteger(totalBytes, 'totalBytes')
  assertFinite(confirmedBytes, 'confirmedBytes')

  const sentByPart = new Map<number, { sentBytes: number; expectedBytes: number }>()
  for (const part of inFlight) {
    assertPositiveSafeInteger(part.partNumber, 'partNumber')
    assertPositiveSafeInteger(part.expectedBytes, 'expectedBytes')
    assertFinite(part.sentBytes, 'sentBytes')

    const sentBytes = boundedBytes(part.sentBytes, part.expectedBytes)
    const previous = sentByPart.get(part.partNumber)
    if (previous !== undefined && previous.expectedBytes !== part.expectedBytes) {
      throw new RangeError(`part ${String(part.partNumber)} has inconsistent expectedBytes`)
    }
    sentByPart.set(part.partNumber, {
      expectedBytes: part.expectedBytes,
      sentBytes: Math.max(previous?.sentBytes ?? 0, sentBytes),
    })
  }

  const authoritativeBytes = boundedBytes(confirmedBytes, totalBytes)
  let displayedBytes = authoritativeBytes
  for (const part of sentByPart.values()) displayedBytes += part.sentBytes
  displayedBytes = boundedBytes(displayedBytes, totalBytes)

  return {
    bytes: displayedBytes,
    percent: roundedPercent(displayedBytes, totalBytes),
  }
}

/**
 * Keeps upload-task callbacks separate from server-confirmed progress.
 * A part is removed from the in-flight map before a response baseline is applied.
 */
export class UploadProgressTracker {
  readonly #totalBytes: number
  readonly #inFlight = new Map<number, InFlightPartProgress>()
  #confirmedBytes: number
  #displayedBytes: number

  constructor(totalBytes: number, confirmedBytes = 0) {
    assertPositiveSafeInteger(totalBytes, 'totalBytes')
    assertFinite(confirmedBytes, 'confirmedBytes')
    this.#totalBytes = totalBytes
    this.#confirmedBytes = boundedBytes(confirmedBytes, totalBytes)
    this.#displayedBytes = this.#confirmedBytes
  }

  startPart(partNumber: number, expectedBytes: number): UploadProgress {
    assertPositiveSafeInteger(partNumber, 'partNumber')
    assertPositiveSafeInteger(expectedBytes, 'expectedBytes')
    const current = this.#inFlight.get(partNumber)
    if (current !== undefined && current.expectedBytes !== expectedBytes) {
      throw new RangeError(`part ${String(partNumber)} has inconsistent expectedBytes`)
    }
    if (current === undefined) {
      this.#inFlight.set(partNumber, { partNumber, expectedBytes, sentBytes: 0 })
    }
    return this.snapshot()
  }

  updatePart(partNumber: number, sentBytes: number): UploadProgress {
    assertPositiveSafeInteger(partNumber, 'partNumber')
    assertFinite(sentBytes, 'sentBytes')
    const current = this.#inFlight.get(partNumber)
    if (current === undefined) throw new Error(`part ${String(partNumber)} is not in flight`)
    this.#inFlight.set(partNumber, {
      ...current,
      sentBytes: Math.max(current.sentBytes, boundedBytes(sentBytes, current.expectedBytes)),
    })
    return this.snapshot()
  }

  discardPart(partNumber: number): UploadProgress {
    assertPositiveSafeInteger(partNumber, 'partNumber')
    this.#inFlight.delete(partNumber)
    return this.snapshot()
  }

  confirmPart(partNumber: number, responseConfirmedBytes: number): UploadProgress {
    assertPositiveSafeInteger(partNumber, 'partNumber')
    assertFinite(responseConfirmedBytes, 'responseConfirmedBytes')
    this.#inFlight.delete(partNumber)
    this.#confirmedBytes = Math.max(
      this.#confirmedBytes,
      boundedBytes(responseConfirmedBytes, this.#totalBytes),
    )
    return this.snapshot()
  }

  resetFromServer(confirmedBytes: number): UploadProgress {
    assertFinite(confirmedBytes, 'confirmedBytes')
    this.#inFlight.clear()
    this.#confirmedBytes = boundedBytes(confirmedBytes, this.#totalBytes)
    this.#displayedBytes = this.#confirmedBytes
    return this.snapshot()
  }

  snapshot(): UploadProgress {
    const current = calculateProgress(this.#confirmedBytes, this.#totalBytes, [
      ...this.#inFlight.values(),
    ])
    this.#displayedBytes = Math.max(this.#displayedBytes, current.bytes)
    return {
      bytes: this.#displayedBytes,
      percent: roundedPercent(this.#displayedBytes, this.#totalBytes),
    }
  }
}
