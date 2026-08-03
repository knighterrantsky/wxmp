import type { PublicUploadStatus } from '@wx-upload/contracts'

export type UploadSessionStatus =
  | 'initiating'
  | 'uploading'
  | 'completing'
  | 'completed'
  | 'aborting'
  | 'aborted'
  | 'expired'
  | 'failed'

export type MediaStorageStatus = 'pending_upload' | 'ready' | 'failed' | 'aborted' | 'purged'

export function projectPublicStatus(
  uploadStatus: UploadSessionStatus,
  mediaStatus: MediaStorageStatus,
  serverReceived = false,
): PublicUploadStatus {
  if (serverReceived) return 'uploaded'
  if (uploadStatus === 'aborting') return 'cancelling'
  // Callers must explicitly prove that all bytes reached the server before the
  // internal queue state can be presented as uploaded.
  if (uploadStatus === 'completing' && mediaStatus === 'pending_upload') return 'finalizing'
  if (uploadStatus === 'completed' && mediaStatus === 'ready') return 'uploaded'
  if (uploadStatus === 'failed' || mediaStatus === 'failed') return 'upload_failed'
  if (uploadStatus === 'aborted' && mediaStatus === 'aborted') return 'aborted'
  if (uploadStatus === 'expired' && mediaStatus === 'aborted') return 'expired'
  if (
    (uploadStatus === 'initiating' || uploadStatus === 'uploading') &&
    mediaStatus === 'pending_upload'
  ) {
    return 'uploading'
  }
  return 'upload_failed'
}
