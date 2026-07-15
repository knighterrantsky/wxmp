import type { PublicUploadStatus } from '@wx-upload/contracts'

export type StatusTone = 'progress' | 'success' | 'warning' | 'error' | 'neutral'

export interface PublicStatusCopy {
  readonly label: string
  readonly tone: StatusTone
  readonly terminal: boolean
}

export function statusCopy(status: PublicUploadStatus): PublicStatusCopy {
  switch (status) {
    case 'uploading':
      return { label: '上传中', tone: 'progress', terminal: false }
    case 'finalizing':
      return { label: '正在完成', tone: 'progress', terminal: false }
    case 'cancelling':
      return { label: '正在取消', tone: 'warning', terminal: false }
    case 'uploaded':
      return { label: '已上传', tone: 'success', terminal: true }
    case 'upload_failed':
      return { label: '上传失败', tone: 'error', terminal: true }
    case 'aborted':
      return { label: '已取消', tone: 'neutral', terminal: true }
    case 'expired':
      return { label: '已过期', tone: 'warning', terminal: true }
    default:
      throw new TypeError('Unknown public upload status')
  }
}
