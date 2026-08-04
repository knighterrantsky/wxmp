import { describe, expect, it, vi } from 'vitest'

import { PostgresAdminUploadRepository } from '../../src/admin/admin-repository.js'

describe('admin upload repository', () => {
  it('returns aggregate queue and failure categories', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          users: '4',
          total: '9',
          server_receiving: '1',
          r2_retrying: '2',
          r2_ready: '3',
          user_reupload: '1',
          operator_review: '1',
          cancelled: '1',
        },
      ],
    })
    const repository = new PostgresAdminUploadRepository({ pool: { query } })

    await expect(repository.summary()).resolves.toEqual({
      users: 4,
      total: 9,
      serverReceiving: 1,
      r2Retrying: 2,
      r2Ready: 3,
      userReupload: 1,
      operatorReview: 1,
      cancelled: 1,
    })
    expect(String(query.mock.calls[0]?.[0])).toContain("category = 'operator_review'")
  })

  it('maps private metadata while keeping all search values parameterized', async () => {
    const createdAt = new Date('2026-08-04T03:00:00.000Z')
    const query = vi.fn().mockImplementation((text: string, values?: readonly unknown[]) => {
      if (text.startsWith('select count')) return Promise.resolve({ rows: [{ total: '1' }] })
      expect(text).toContain("records.original_filename ilike '%' || $2 || '%'")
      expect(text).not.toContain('alice')
      expect(values).toEqual(['operator_review', 'alice', 30, 0])
      return Promise.resolve({
        rows: [
          {
            upload_id: '01981c31-4c80-7000-8000-000000000011',
            media_id: '01981c31-4c80-7000-8000-000000000012',
            user_id: '01981c31-4c80-7000-8000-000000000013',
            nickname: 'Alice',
            app_id: 'wx-test-app',
            openid: 'private-openid',
            original_filename: 'photo.jpg',
            kind: 'image',
            declared_content_type: 'image/jpeg',
            verified_content_type: 'image/jpeg',
            expected_size_bytes: '1024',
            confirmed_size_bytes: '1024',
            upload_status: 'failed',
            storage_status: 'failed',
            category: 'operator_review',
            r2_bucket: 'private-bucket',
            object_key: 'users/id/photo.jpg',
            finalize_attempt_count: 3,
            next_finalize_at: null,
            last_finalize_error_code: 'STORAGE_UNAVAILABLE',
            last_finalize_error_at: createdAt,
            failure_code: 'STORAGE_UNAVAILABLE',
            failure_detail: null,
            created_at: createdAt,
            updated_at: createdAt,
          },
        ],
      })
    })
    const repository = new PostgresAdminUploadRepository({ pool: { query } })

    const page = await repository.list({
      category: 'operator_review',
      query: 'alice',
      limit: 30,
      offset: 0,
    })

    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({
      nickname: 'Alice',
      appId: 'wx-test-app',
      openid: 'private-openid',
      category: 'operator_review',
      expectedSizeBytes: 1024,
      finalizeAttemptCount: 3,
      createdAt: '2026-08-04T03:00:00.000Z',
    })
  })
})
