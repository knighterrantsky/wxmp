import { PUBLIC_UPLOAD_STATUSES, type PublicUploadStatus } from '@wx-upload/contracts'
import { describe, expect, it } from 'vitest'

import {
  projectPublicStatus,
  type MediaStorageStatus,
  type UploadSessionStatus,
} from '../../src/uploads/public-status.js'

describe('projectPublicStatus', () => {
  it.each<
    [
      uploadStatus: UploadSessionStatus,
      mediaStatus: MediaStorageStatus,
      expected: PublicUploadStatus,
    ]
  >([
    ['initiating', 'pending_upload', 'uploading'],
    ['uploading', 'pending_upload', 'uploading'],
    ['completing', 'pending_upload', 'finalizing'],
    ['aborting', 'pending_upload', 'cancelling'],
    ['aborting', 'failed', 'cancelling'],
    ['completed', 'ready', 'uploaded'],
    ['aborted', 'aborted', 'aborted'],
    ['expired', 'aborted', 'expired'],
    ['failed', 'failed', 'upload_failed'],
    ['uploading', 'failed', 'upload_failed'],
    ['completed', 'failed', 'upload_failed'],
  ])('projects %s plus %s as %s', (uploadStatus, mediaStatus, expected) => {
    expect(projectPublicStatus(uploadStatus, mediaStatus)).toBe(expected)
  })

  it('never exposes an internal database status', () => {
    const uploadStatuses: UploadSessionStatus[] = [
      'initiating',
      'uploading',
      'completing',
      'completed',
      'aborting',
      'aborted',
      'expired',
      'failed',
    ]
    const mediaStatuses: MediaStorageStatus[] = [
      'pending_upload',
      'ready',
      'failed',
      'aborted',
      'purged',
    ]

    for (const uploadStatus of uploadStatuses) {
      for (const mediaStatus of mediaStatuses) {
        expect(PUBLIC_UPLOAD_STATUSES).toContain(projectPublicStatus(uploadStatus, mediaStatus))
      }
    }
  })

  it.each([
    ['completed', 'pending_upload'],
    ['uploading', 'ready'],
    ['expired', 'pending_upload'],
    ['aborted', 'purged'],
  ] as const)('fails closed for the impossible combination %s plus %s', (upload, media) => {
    expect(projectPublicStatus(upload, media)).toBe('upload_failed')
  })
})
