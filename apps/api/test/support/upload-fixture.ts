import { createHash } from 'node:crypto'

import { PART_SIZE_BYTES } from '@wx-upload/contracts'
import type { Pool } from 'pg'

export const uploadFixtureNow = new Date('2026-07-15T05:00:00.000Z')
export const uploadOwnerUserId = '01981d0c-ec80-7000-8000-000000000101'
export const uploadOwnerSessionId = '01981d0c-ec80-7000-8000-000000000102'
export const uploadOwnerFamilyId = '01981d0c-ec80-7000-8000-000000000103'
export const otherUploadUserId = '01981d0c-ec80-7000-8000-000000000111'
export const otherUploadSessionId = '01981d0c-ec80-7000-8000-000000000112'
export const otherUploadFamilyId = '01981d0c-ec80-7000-8000-000000000113'
export const uploadFixtureId = '01981d0c-ec80-7000-8000-000000000201'
export const mediaFixtureId = '01981d0c-ec80-7000-8000-000000000202'
export const privateFixtureBucket = 'private-fixture-bucket'
export const privateFixtureKey = 'users/private-owner/2026/07/private-object.png'
export const privateFixtureMultipartId = 'private-multipart-fixture-id'

export const validPngChunk = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8, 0x42),
])

export function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function seedUploadIdentities(pool: Pool): Promise<void> {
  for (const [index, identity] of [
    {
      userId: uploadOwnerUserId,
      sessionId: uploadOwnerSessionId,
      familyId: uploadOwnerFamilyId,
      nickname: '小晴',
    },
    {
      userId: otherUploadUserId,
      sessionId: otherUploadSessionId,
      familyId: otherUploadFamilyId,
      nickname: '阿远',
    },
  ].entries()) {
    await pool.query(
      `insert into media_app.users(
         id, status, nickname, nickname_confirmed_at, created_at, updated_at
       ) values ($1, 'active', $2, $3, $3, $3)`,
      [identity.userId, identity.nickname, uploadFixtureNow],
    )
    await pool.query(
      `insert into media_app.user_sessions(
         id, user_id, token_family_id, refresh_token_hash, issued_at, expires_at
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        identity.sessionId,
        identity.userId,
        identity.familyId,
        Buffer.alloc(32, index + 7),
        uploadFixtureNow,
        new Date('2026-08-14T05:00:00.000Z'),
      ],
    )
  }
}

export interface SeedUploadOptions {
  createdAt?: Date
  expiresAt?: Date
  fileName?: string
  mediaId?: string
  mimeType?: 'image/png' | 'image/jpeg'
  objectKey?: string
  partSizes?: number[]
  uploadId?: string
  userId?: string
}

export async function seedWritableUpload(
  pool: Pool,
  options: SeedUploadOptions = {},
): Promise<{ mediaId: string; uploadId: string; sizeBytes: number }> {
  const uploadId = options.uploadId ?? uploadFixtureId
  const mediaId = options.mediaId ?? mediaFixtureId
  const userId = options.userId ?? uploadOwnerUserId
  const partSizes = options.partSizes ?? [validPngChunk.length]
  const sizeBytes = partSizes.reduce((total, size) => total + size, 0)
  const mimeType = options.mimeType ?? 'image/png'
  const extension = mimeType === 'image/png' ? '.png' : '.jpg'
  const createdAt = options.createdAt ?? uploadFixtureNow

  await pool.query(
    `insert into media_app.media_objects(
       id, user_id, kind, storage_status, original_filename,
       uploader_nickname_snapshot, declared_content_type, canonical_extension,
       declared_size_bytes, r2_bucket, object_key, create_idempotency_key,
       created_at, updated_at
     ) values ($1, $2, 'image', 'pending_upload', $3, '小晴', $4, $5,
               $6, $7, $8, 'fixture-idempotency-key', $9, $9)`,
    [
      mediaId,
      userId,
      options.fileName ?? `fixture${extension}`,
      mimeType,
      extension,
      sizeBytes,
      privateFixtureBucket,
      options.objectKey ?? privateFixtureKey,
      createdAt,
    ],
  )
  await pool.query(
    `insert into media_app.upload_sessions(
       id, media_object_id, user_id, status, r2_upload_id,
       expected_size_bytes, expires_at, last_activity_at, created_at, updated_at
     ) values ($1, $2, $3, 'uploading', $4, $5, $6, $7, $7, $7)`,
    [
      uploadId,
      mediaId,
      userId,
      privateFixtureMultipartId,
      sizeBytes,
      options.expiresAt ?? new Date('2026-07-16T05:00:00.000Z'),
      createdAt,
    ],
  )

  let offset = 0
  for (const [index, size] of partSizes.entries()) {
    await pool.query(
      `insert into media_app.upload_parts(
         upload_session_id, part_number, status, offset_bytes,
         expected_size_bytes, created_at, updated_at
       ) values ($1, $2, 'pending', $3, $4, $5, $5)`,
      [uploadId, index + 1, offset, size, uploadFixtureNow],
    )
    offset += size
  }
  return { mediaId, uploadId, sizeBytes }
}

export function multipartPayload(input: {
  boundary: string
  chunk?: Buffer
  chunkSizeBytes?: string
  chunkFirst?: boolean
  extraField?: boolean
}): Buffer {
  const field =
    input.chunkSizeBytes === undefined
      ? []
      : [
          Buffer.from(
            `--${input.boundary}\r\nContent-Disposition: form-data; name="chunkSizeBytes"\r\n\r\n${input.chunkSizeBytes}\r\n`,
          ),
        ]
  const file =
    input.chunk === undefined
      ? []
      : [
          Buffer.from(
            `--${input.boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          input.chunk,
          Buffer.from('\r\n'),
        ]
  const extra = input.extraField
    ? [
        Buffer.from(
          `--${input.boundary}\r\nContent-Disposition: form-data; name="unexpected"\r\n\r\nvalue\r\n`,
        ),
      ]
    : []
  const ordered = input.chunkFirst === true ? [...file, ...field] : [...field, ...file]
  return Buffer.concat([...ordered, ...extra, Buffer.from(`--${input.boundary}--\r\n`)])
}

export const twoPartFixtureSizes = [PART_SIZE_BYTES, 16]
