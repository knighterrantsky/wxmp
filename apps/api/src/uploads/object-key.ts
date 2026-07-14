import { UUID_V7_PATTERN } from '@wx-upload/contracts'

const UUID_V7 = new RegExp(UUID_V7_PATTERN, 'u')
const CANONICAL_EXTENSIONS = new Set([
  '.jpg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.mp4',
  '.mov',
])

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

export function buildObjectKey(input: {
  userId: string
  mediaId: string
  kind: string
  extension: string
  now: Date
}): string {
  const year = input.now.getUTCFullYear()
  if (
    !UUID_V7.test(input.userId) ||
    !UUID_V7.test(input.mediaId) ||
    (input.kind !== 'image' && input.kind !== 'video') ||
    !CANONICAL_EXTENSIONS.has(input.extension) ||
    !Number.isFinite(input.now.getTime()) ||
    year < 1 ||
    year > 9_999
  ) {
    throw new TypeError('invalid object key input')
  }
  const month = twoDigits(input.now.getUTCMonth() + 1)
  return `users/${input.userId}/${input.kind}/${String(year).padStart(4, '0')}/${month}/${input.mediaId}${input.extension}`
}
