import {
  MAX_FILE_SIZE_BYTES,
  MAX_SELECTION_COUNT,
  MIN_FILE_SIZE_BYTES,
  type AllowedMimeType,
  type MediaKind,
} from '@wx-upload/contracts'

export type MediaValidationCode =
  | 'SELECTION_EMPTY'
  | 'SELECTION_LIMIT_EXCEEDED'
  | 'INVALID_FILE_SIZE'
  | 'FILE_TOO_SMALL'
  | 'FILE_TOO_LARGE'
  | 'FILE_UNREADABLE'
  | 'DUPLICATE_SOURCE_PATH'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MIME_EXTENSION_MISMATCH'
  | 'KIND_MISMATCH'

export interface MediaSelectionCandidate {
  readonly sourcePath: string
  readonly fileName?: string | undefined
  readonly sizeBytes: number
  readonly kind: MediaKind
  readonly mimeType?: string | undefined
  readonly readable: boolean
}

export interface ValidatedMedia {
  readonly sourcePath: string
  readonly fileName: string
  readonly sizeBytes: number
  readonly kind: MediaKind
  readonly mimeType: AllowedMimeType
}

export type FirstPartSignatureStatus = 'pending' | 'accepted' | 'rejected'

interface MediaDeclaration {
  readonly kind: MediaKind
  readonly mimeType: AllowedMimeType
}

const DECLARATION_BY_EXTENSION = {
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.heic': { kind: 'image', mimeType: 'image/heic' },
  '.heif': { kind: 'image', mimeType: 'image/heif' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.m4v': { kind: 'video', mimeType: 'video/mp4' },
  '.mov': { kind: 'video', mimeType: 'video/quicktime' },
} as const satisfies Readonly<Record<string, MediaDeclaration>>

export class MediaValidationError extends Error {
  override readonly name = 'MediaValidationError'
  readonly code: MediaValidationCode
  readonly itemIndex: number | null

  constructor(code: MediaValidationCode, itemIndex: number | null = null) {
    super(itemIndex === null ? code : `${code} at selection index ${String(itemIndex)}`)
    this.code = code
    this.itemIndex = itemIndex
  }
}

function withoutQueryOrFragment(value: string): string {
  const query = value.indexOf('?')
  const fragment = value.indexOf('#')
  const end = Math.min(query < 0 ? value.length : query, fragment < 0 ? value.length : fragment)
  return value.slice(0, end)
}

function basename(value: string): string {
  const clean = withoutQueryOrFragment(value).replaceAll('\\', '/')
  return clean.slice(clean.lastIndexOf('/') + 1)
}

function extension(value: string): string {
  const name = basename(value)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function declarationForExtension(value: string): MediaDeclaration | undefined {
  return DECLARATION_BY_EXTENSION[value as keyof typeof DECLARATION_BY_EXTENSION]
}

function supportedSource(candidate: MediaSelectionCandidate): {
  declaration: MediaDeclaration
  extension: string
} {
  const sourceExtension = extension(candidate.sourcePath)
  const namedExtension = extension(candidate.fileName ?? '')
  const resolvedExtension = sourceExtension || namedExtension
  const declaration = declarationForExtension(resolvedExtension)
  if (declaration === undefined) throw new MediaValidationError('UNSUPPORTED_MEDIA_TYPE')
  return { declaration, extension: resolvedExtension }
}

function validatedFileName(candidate: MediaSelectionCandidate, resolvedExtension: string): string {
  const candidateName = candidate.fileName?.trim()
  const preferred = basename(
    candidateName === undefined || candidateName === '' ? candidate.sourcePath : candidateName,
  )
  const withoutControlCharacters = Array.from(preferred)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && (codePoint < 127 || codePoint > 159)
    })
    .join('')
  if (
    withoutControlCharacters !== '' &&
    withoutControlCharacters !== '.' &&
    withoutControlCharacters !== '..' &&
    extension(withoutControlCharacters) === resolvedExtension
  ) {
    return withoutControlCharacters
  }
  const stem = withoutControlCharacters.replace(/\.[^.]*$/u, '').trim()
  const safeStem = stem === '' || stem === '.' || stem === '..' ? 'upload' : stem
  return `${safeStem}${resolvedExtension}`
}

function validateCandidate(candidate: MediaSelectionCandidate, itemIndex: number): ValidatedMedia {
  if (!Number.isFinite(candidate.sizeBytes) || !Number.isSafeInteger(candidate.sizeBytes)) {
    throw new MediaValidationError('INVALID_FILE_SIZE', itemIndex)
  }
  if (candidate.sizeBytes < MIN_FILE_SIZE_BYTES) {
    throw new MediaValidationError('FILE_TOO_SMALL', itemIndex)
  }
  if (candidate.sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new MediaValidationError('FILE_TOO_LARGE', itemIndex)
  }
  if (!candidate.readable || candidate.sourcePath.trim() === '') {
    throw new MediaValidationError('FILE_UNREADABLE', itemIndex)
  }

  let resolved: ReturnType<typeof supportedSource>
  try {
    resolved = supportedSource(candidate)
  } catch (error) {
    if (error instanceof MediaValidationError) {
      throw new MediaValidationError(error.code, itemIndex)
    }
    throw error
  }

  if (resolved.declaration.kind !== candidate.kind) {
    throw new MediaValidationError('KIND_MISMATCH', itemIndex)
  }

  const declaredMime = candidate.mimeType?.trim().toLowerCase()
  if (declaredMime !== undefined && declaredMime !== resolved.declaration.mimeType) {
    throw new MediaValidationError('MIME_EXTENSION_MISMATCH', itemIndex)
  }

  return {
    sourcePath: candidate.sourcePath,
    fileName: validatedFileName(candidate, resolved.extension),
    sizeBytes: candidate.sizeBytes,
    kind: candidate.kind,
    mimeType: resolved.declaration.mimeType,
  }
}

export function validateMediaSelection(
  selection: readonly MediaSelectionCandidate[],
): ValidatedMedia[] {
  if (selection.length === 0) throw new MediaValidationError('SELECTION_EMPTY')
  if (selection.length > MAX_SELECTION_COUNT) {
    throw new MediaValidationError('SELECTION_LIMIT_EXCEEDED')
  }
  const sourcePaths = new Set<string>()
  return selection.map((candidate, itemIndex) => {
    if (sourcePaths.has(candidate.sourcePath)) {
      throw new MediaValidationError('DUPLICATE_SOURCE_PATH', itemIndex)
    }
    sourcePaths.add(candidate.sourcePath)
    return validateCandidate(candidate, itemIndex)
  })
}

/**
 * Only part one may start while the server-side magic-byte check is pending.
 * A successful part-one response changes the status to `accepted`.
 */
export function canSchedulePart(
  partNumber: number,
  signatureStatus: FirstPartSignatureStatus,
): boolean {
  if (!Number.isSafeInteger(partNumber) || partNumber <= 0) {
    throw new RangeError('partNumber must be a positive safe integer')
  }
  if (signatureStatus === 'rejected') return false
  return signatureStatus === 'accepted' || partNumber === 1
}
