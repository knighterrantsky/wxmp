export type UploadLifecycleStatus =
  | 'selected'
  | 'queued'
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'finalizing'
  | 'cancelling'
  | 'uploaded'
  | 'failed'
  | 'cancelled'
  | 'aborted'
  | 'expired'

export interface UploadState {
  readonly status: UploadLifecycleStatus
}

export interface UploadTransitionAction {
  readonly type: 'transition'
  readonly status: UploadLifecycleStatus
}

export type UploadAction = UploadTransitionAction

const TERMINAL_STATUSES = new Set<UploadLifecycleStatus>([
  'uploaded',
  'failed',
  'cancelled',
  'aborted',
  'expired',
])

const ALLOWED_TRANSITIONS = {
  selected: new Set<UploadLifecycleStatus>(['queued', 'cancelled']),
  queued: new Set<UploadLifecycleStatus>(['initializing', 'cancelled', 'failed']),
  initializing: new Set<UploadLifecycleStatus>(['uploading', 'failed']),
  uploading: new Set<UploadLifecycleStatus>(['paused', 'finalizing', 'cancelling', 'failed']),
  paused: new Set<UploadLifecycleStatus>(['uploading', 'cancelling', 'failed']),
  finalizing: new Set<UploadLifecycleStatus>(['uploading', 'uploaded', 'cancelling', 'failed']),
  cancelling: new Set<UploadLifecycleStatus>(['aborted', 'expired', 'failed']),
  uploaded: new Set<UploadLifecycleStatus>(),
  failed: new Set<UploadLifecycleStatus>(),
  cancelled: new Set<UploadLifecycleStatus>(),
  aborted: new Set<UploadLifecycleStatus>(),
  expired: new Set<UploadLifecycleStatus>(),
} as const satisfies Readonly<Record<UploadLifecycleStatus, ReadonlySet<UploadLifecycleStatus>>>

export class InvalidUploadTransitionError extends Error {
  override readonly name = 'InvalidUploadTransitionError'
  readonly from: UploadLifecycleStatus
  readonly to: UploadLifecycleStatus

  constructor(from: UploadLifecycleStatus, to: UploadLifecycleStatus) {
    super(`cannot transition ${from} -> ${to}`)
    this.from = from
    this.to = to
  }
}

export function isTerminalUploadStatus(status: UploadLifecycleStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function transitionUploadStatus(
  current: UploadLifecycleStatus,
  next: UploadLifecycleStatus,
): UploadLifecycleStatus {
  if (current === next) return current
  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new InvalidUploadTransitionError(current, next)
  }
  return next
}

export function createUploadState(): UploadState {
  return { status: 'selected' }
}

export function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  return { status: transitionUploadStatus(state.status, action.status) }
}
