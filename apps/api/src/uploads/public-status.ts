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
): PublicUploadStatus {
  if (uploadStatus === 'aborting') return 'cancelling'
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
