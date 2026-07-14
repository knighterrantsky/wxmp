import { Counter, Gauge, Histogram, Registry } from 'prom-client'

type LoginOutcome = 'success' | 'error'
type UploadInitializationOutcome = 'accepted' | 'rejected' | 'error'
type PartOutcome = 'uploaded' | 'retried' | 'error' | 'checksumMismatch'
type R2Operation =
  'create' | 'uploadPart' | 'complete' | 'abort' | 'head' | 'listParts' | 'listMultipartUploads'
type OperationOutcome = 'success' | 'error' | 'timeout'
type FinalizerRetryOutcome = 'scheduled' | 'succeeded' | 'exhausted'
type ReconciliationOutcome = 'confirmed' | 'repaired' | 'failed'
type CriticalReconciliationCode =
  | 'ACCESS_DENIED'
  | 'INVALID_REQUEST'
  | 'STORAGE_OBJECT_PRESENT'
  | 'STORAGE_OBJECT_SIZE_MISMATCH'
  | 'STORAGE_UNAVAILABLE'

const LOGIN_OUTCOMES = ['success', 'error'] as const
const INITIALIZATION_OUTCOMES = ['accepted', 'rejected', 'error'] as const
const PART_OUTCOMES = ['uploaded', 'retried', 'error', 'checksumMismatch'] as const
const R2_OPERATIONS = [
  'create',
  'uploadPart',
  'complete',
  'abort',
  'head',
  'listParts',
  'listMultipartUploads',
] as const
const OPERATION_OUTCOMES = ['success', 'error', 'timeout'] as const
const FINALIZER_RETRY_OUTCOMES = ['scheduled', 'succeeded', 'exhausted'] as const
const RECONCILIATION_OUTCOMES = ['confirmed', 'repaired', 'failed'] as const
const CRITICAL_RECONCILIATION_CODES = [
  'ACCESS_DENIED',
  'INVALID_REQUEST',
  'STORAGE_OBJECT_PRESENT',
  'STORAGE_OBJECT_SIZE_MISMATCH',
  'STORAGE_UNAVAILABLE',
] as const

function assertMetricLabel(value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) throw new Error('Metric label is outside its whitelist')
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid metric ${name}`)
}

export class Metrics {
  readonly contentType: string
  readonly #registry = new Registry()
  readonly #loginTotal: Counter<'outcome'>
  readonly #wechatDuration: Histogram<'outcome'>
  readonly #uploadInitializations: Counter<'outcome'>
  readonly #activeUploads: Gauge
  readonly #uploadBytes: Counter
  readonly #partTotal: Counter<'outcome'>
  readonly #partDuration: Histogram<'outcome'>
  readonly #partBytes: Counter
  readonly #partRetries: Counter<'outcome'>
  readonly #checksumMismatches: Counter
  readonly #r2Duration: Histogram<'operation' | 'outcome'>
  readonly #r2Errors: Counter<'operation' | 'outcome'>
  readonly #finalizerBacklog: Gauge
  readonly #finalizerRetries: Counter<'outcome'>
  readonly #abortBacklog: Gauge
  readonly #abortRetries: Counter<'outcome'>
  readonly #reconciliation: Counter<'outcome'>
  readonly #criticalReconciliation: Counter<'code'>
  readonly #completingTimeouts: Counter
  readonly #expiredSessions: Counter

  constructor() {
    this.contentType = this.#registry.contentType
    this.#loginTotal = new Counter({
      name: 'wx_upload_login_total',
      help: 'WeChat login attempts by bounded outcome.',
      labelNames: ['outcome'],
      registers: [this.#registry],
    })
    this.#wechatDuration = new Histogram({
      name: 'wx_upload_wechat_upstream_duration_seconds',
      help: 'WeChat login upstream latency.',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.#registry],
    })
    this.#uploadInitializations = new Counter({
      name: 'wx_upload_initializations_total',
      help: 'Upload initialization attempts by bounded outcome.',
      labelNames: ['outcome'],
      registers: [this.#registry],
    })
    this.#activeUploads = new Gauge({
      name: 'wx_upload_active_uploads',
      help: 'Current active upload sessions.',
      registers: [this.#registry],
    })
    this.#uploadBytes = new Counter({
      name: 'wx_upload_bytes_total',
      help: 'Bytes accepted for private uploads.',
      registers: [this.#registry],
    })
    this.#partTotal = new Counter({
      name: 'wx_upload_parts_total',
      help: 'Upload part results by bounded outcome.',
      labelNames: ['outcome'],
      registers: [this.#registry],
    })
    this.#partDuration = new Histogram({
      name: 'wx_upload_part_duration_seconds',
      help: 'Upload part processing latency.',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.#registry],
    })
    this.#partBytes = new Counter({
      name: 'wx_upload_part_bytes_total',
      help: 'Bytes accepted in uploaded parts.',
      registers: [this.#registry],
    })
    this.#partRetries = new Counter({
      name: 'wx_upload_part_retries_total',
      help: 'Upload part retries by bounded outcome.',
      labelNames: ['outcome'],
      registers: [this.#registry],
    })
    this.#checksumMismatches = new Counter({
      name: 'wx_upload_part_checksum_mismatches_total',
      help: 'Upload part checksum mismatches.',
      registers: [this.#registry],
    })
    this.#r2Duration = new Histogram({
      name: 'wx_upload_r2_operation_duration_seconds',
      help: 'R2 operation latency by bounded operation and outcome.',
      labelNames: ['operation', 'outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.#registry],
    })
    this.#r2Errors = new Counter({
      name: 'wx_upload_r2_operation_errors_total',
      help: 'R2 operation failures by bounded operation and outcome.',
      labelNames: ['operation', 'outcome'],
      registers: [this.#registry],
    })
    this.#finalizerBacklog = new Gauge({
      name: 'wx_upload_finalizer_backlog',
      help: 'Upload sessions awaiting finalization.',
      registers: [this.#registry],
    })
    this.#finalizerRetries = new Counter({
      name: 'wx_upload_finalizer_retries_total',
      help: 'Finalizer retry results.',
      labelNames: ['outcome'],
      registers: [this.#registry],
    })
    this.#abortBacklog = new Gauge({
      name: 'wx_upload_abort_backlog',
      help: 'Upload sessions awaiting multipart cleanup.',
      registers: [this.#registry],
    })
    this.#abortRetries = new Counter({
      name: 'wx_upload_abort_retries_total',
      help: 'Abort worker retry results.',
      labelNames: ['outcome'],
      registers: [this.#registry],
    })
    this.#reconciliation = new Counter({
      name: 'wx_upload_reconciliation_total',
      help: 'Reconciliation results.',
      labelNames: ['outcome'],
      registers: [this.#registry],
    })
    this.#criticalReconciliation = new Counter({
      name: 'wx_upload_critical_reconciliation_total',
      help: 'Critical private-storage reconciliation findings by bounded code.',
      labelNames: ['code'],
      registers: [this.#registry],
    })
    this.#completingTimeouts = new Counter({
      name: 'wx_upload_completing_timeouts_total',
      help: 'Upload sessions exceeding the completing deadline.',
      registers: [this.#registry],
    })
    this.#expiredSessions = new Counter({
      name: 'wx_upload_expired_sessions_total',
      help: 'Expired upload sessions.',
      registers: [this.#registry],
    })
  }

  recordLogin(input: { outcome: LoginOutcome; durationSeconds: number }): void {
    assertMetricLabel(input.outcome, LOGIN_OUTCOMES)
    assertNonNegative(input.durationSeconds, 'duration')
    this.#loginTotal.inc({ outcome: input.outcome })
    this.#wechatDuration.observe({ outcome: input.outcome }, input.durationSeconds)
  }

  recordUploadInitialization(input: { outcome: UploadInitializationOutcome }): void {
    assertMetricLabel(input.outcome, INITIALIZATION_OUTCOMES)
    this.#uploadInitializations.inc({ outcome: input.outcome })
  }

  setActiveUploads(value: number): void {
    assertNonNegative(value, 'active uploads')
    this.#activeUploads.set(value)
  }

  addUploadBytes(bytes: number): void {
    assertNonNegative(bytes, 'upload bytes')
    this.#uploadBytes.inc(bytes)
  }

  recordPart(input: { outcome: PartOutcome; durationSeconds: number; bytes: number }): void {
    assertMetricLabel(input.outcome, PART_OUTCOMES)
    assertNonNegative(input.durationSeconds, 'duration')
    assertNonNegative(input.bytes, 'part bytes')
    this.#partTotal.inc({ outcome: input.outcome })
    this.#partDuration.observe({ outcome: input.outcome }, input.durationSeconds)
    if (input.bytes > 0) this.#partBytes.inc(input.bytes)
    if (input.outcome === 'retried') this.#partRetries.inc({ outcome: input.outcome })
    if (input.outcome === 'checksumMismatch') this.#checksumMismatches.inc()
  }

  recordR2Operation(input: {
    operation: R2Operation
    outcome: OperationOutcome
    durationSeconds: number
  }): void {
    assertMetricLabel(input.operation, R2_OPERATIONS)
    assertMetricLabel(input.outcome, OPERATION_OUTCOMES)
    assertNonNegative(input.durationSeconds, 'duration')
    this.#r2Duration.observe(
      { operation: input.operation, outcome: input.outcome },
      input.durationSeconds,
    )
    if (input.outcome !== 'success') {
      this.#r2Errors.inc({ operation: input.operation, outcome: input.outcome })
    }
  }

  setFinalizerBacklog(value: number): void {
    assertNonNegative(value, 'finalizer backlog')
    this.#finalizerBacklog.set(value)
  }

  recordFinalizerRetry(input: { outcome: FinalizerRetryOutcome }): void {
    assertMetricLabel(input.outcome, FINALIZER_RETRY_OUTCOMES)
    this.#finalizerRetries.inc({ outcome: input.outcome })
  }

  setAbortBacklog(value: number): void {
    assertNonNegative(value, 'abort backlog')
    this.#abortBacklog.set(value)
  }

  recordAbortRetry(input: { outcome: FinalizerRetryOutcome }): void {
    assertMetricLabel(input.outcome, FINALIZER_RETRY_OUTCOMES)
    this.#abortRetries.inc({ outcome: input.outcome })
  }

  recordReconciliation(input: { outcome: ReconciliationOutcome }): void {
    assertMetricLabel(input.outcome, RECONCILIATION_OUTCOMES)
    this.#reconciliation.inc({ outcome: input.outcome })
  }

  criticalReconciliation(code: CriticalReconciliationCode): void {
    assertMetricLabel(code, CRITICAL_RECONCILIATION_CODES)
    this.#criticalReconciliation.inc({ code })
  }

  recordCompletingTimeout(): void {
    this.#completingTimeouts.inc()
  }

  recordExpiredSession(): void {
    this.#expiredSessions.inc()
  }

  render(): Promise<string> {
    return this.#registry.metrics()
  }
}
