import { PUBLIC_UPLOAD_STATUSES, type PublicUploadStatus } from '@wx-upload/contracts'
import { describe, expect, it } from 'vitest'

import { statusCopy } from '../miniprogram/core/status-copy.js'

describe('statusCopy', () => {
  it.each([
    ['uploading', { label: '上传中', tone: 'progress', terminal: false }],
    ['finalizing', { label: '正在完成', tone: 'progress', terminal: false }],
    ['cancelling', { label: '正在取消', tone: 'warning', terminal: false }],
    ['uploaded', { label: '已上传', tone: 'success', terminal: true }],
    ['upload_failed', { label: '上传失败', tone: 'error', terminal: true }],
    ['aborted', { label: '已取消', tone: 'neutral', terminal: true }],
    ['expired', { label: '已过期', tone: 'warning', terminal: true }],
  ] as const)('maps %s to concise public copy', (status, expected) => {
    expect(statusCopy(status)).toEqual(expected)
  })

  it('covers exactly every public upload status', () => {
    expect(PUBLIC_UPLOAD_STATUSES.map((status) => statusCopy(status).label)).toHaveLength(7)
  })

  it('fails closed for a status outside the public contract', () => {
    expect(() => statusCopy('processing' as PublicUploadStatus)).toThrow(/status/u)
  })
})
