import {
  MAX_FILE_SIZE_BYTES,
  MIN_FILE_SIZE_BYTES,
  type InitializeUploadRequest,
  type MediaKind,
} from '@wx-upload/contracts'

import { ApiError } from '../http/errors.js'

export interface InitializeUploadCandidate {
  fileName: string
  kind: 'image' | 'video'
  mimeType: string
  sizeBytes: number
}

const MEDIA_TYPES = new Map<
  string,
  { kind: MediaKind; extensions: ReadonlySet<string>; canonicalExtension: string }
>([
  [
    'image/jpeg',
    { kind: 'image', extensions: new Set(['.jpg', '.jpeg']), canonicalExtension: '.jpg' },
  ],
  ['image/png', { kind: 'image', extensions: new Set(['.png']), canonicalExtension: '.png' }],
  ['image/webp', { kind: 'image', extensions: new Set(['.webp']), canonicalExtension: '.webp' }],
  ['image/gif', { kind: 'image', extensions: new Set(['.gif']), canonicalExtension: '.gif' }],
  ['image/heic', { kind: 'image', extensions: new Set(['.heic']), canonicalExtension: '.heic' }],
  ['image/heif', { kind: 'image', extensions: new Set(['.heif']), canonicalExtension: '.heif' }],
  [
    'video/mp4',
    { kind: 'video', extensions: new Set(['.mp4', '.m4v']), canonicalExtension: '.mp4' },
  ],
  ['video/quicktime', { kind: 'video', extensions: new Set(['.mov']), canonicalExtension: '.mov' }],
])

function policyError(
  code: 'VALIDATION_ERROR' | 'FILE_TOO_SMALL' | 'FILE_TOO_LARGE' | 'FILE_TYPE_NOT_ALLOWED',
  statusCode: number,
): never {
  throw new ApiError({ code, message: code, statusCode })
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))) {
      return true
    }
  }
  return false
}

function normalizeFileName(fileName: unknown): string {
  if (typeof fileName !== 'string' || !isWellFormedUnicode(fileName)) {
    return policyError('VALIDATION_ERROR', 422)
  }
  const normalized = fileName.normalize('NFC')
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.trim().length === 0 ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    hasControlCharacter(normalized)
  ) {
    return policyError('VALIDATION_ERROR', 422)
  }
  const bytes = Buffer.byteLength(normalized, 'utf8')
  if (bytes < 1 || bytes > 255) return policyError('VALIDATION_ERROR', 422)
  return normalized
}

function extension(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return undefined
  return fileName.slice(dot).toLowerCase()
}

export function validateMediaPolicy(request: InitializeUploadCandidate): {
  fileName: string
  canonicalExtension: string
  request: InitializeUploadRequest
} {
  if (!Number.isSafeInteger(request.sizeBytes)) return policyError('VALIDATION_ERROR', 422)
  if (request.sizeBytes < MIN_FILE_SIZE_BYTES) return policyError('FILE_TOO_SMALL', 422)
  if (request.sizeBytes > MAX_FILE_SIZE_BYTES) return policyError('FILE_TOO_LARGE', 413)

  const fileName = normalizeFileName(request.fileName)
  const type = MEDIA_TYPES.get(request.mimeType)
  const fileExtension = extension(fileName)
  if (type === undefined) return policyError('FILE_TYPE_NOT_ALLOWED', 415)
  if (request.kind !== type.kind || !type.extensions.has(fileExtension ?? '')) {
    return policyError('FILE_TYPE_NOT_ALLOWED', 415)
  }
  return {
    fileName,
    canonicalExtension: type.canonicalExtension,
    request: {
      fileName,
      kind: type.kind,
      mimeType: request.mimeType,
      sizeBytes: request.sizeBytes,
    } as InitializeUploadRequest,
  }
}
