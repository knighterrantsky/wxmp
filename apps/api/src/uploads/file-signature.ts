import type { AllowedMimeType } from '@wx-upload/contracts'

export const FILE_SIGNATURE_PREFIX_BYTES = 256

export type CanonicalMediaExtension =
  '.jpg' | '.png' | '.webp' | '.gif' | '.heic' | '.heif' | '.mp4' | '.mov'

export interface FileSignatureDeclaration {
  mimeType: AllowedMimeType
  canonicalExtension: string
}

export type FileSignatureValidationResult =
  | { ok: true }
  | {
      ok: false
      reason: 'TRUNCATED' | 'UNRECOGNIZED' | 'DECLARATION_MISMATCH'
    }

type DetectionResult =
  | { status: 'recognized'; mimeTypes: ReadonlySet<AllowedMimeType> }
  | { status: 'truncated' }
  | { status: 'unrecognized' }

const CANONICAL_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
} as const satisfies Readonly<Record<AllowedMimeType, CanonicalMediaExtension>>

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const GIF_SIGNATURES = [Buffer.from('GIF87a', 'ascii'), Buffer.from('GIF89a', 'ascii')] as const
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii')
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii')
const WEBP_CHUNK_TYPES = [
  Buffer.from('VP8 ', 'ascii'),
  Buffer.from('VP8L', 'ascii'),
  Buffer.from('VP8X', 'ascii'),
] as const
const FTYP_SIGNATURE = Buffer.from('ftyp', 'ascii')

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'])
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'avc1',
  'hvc1',
  'hev1',
  'mp41',
  'mp42',
  'M4V ',
])

function matchedBytes(bytes: Buffer, offset: number, signature: Buffer): number {
  const available = Math.max(0, Math.min(bytes.length - offset, signature.length))
  for (let index = 0; index < available; index += 1) {
    if (bytes[offset + index] !== signature[index]) return -1
  }
  return available
}

function fixedSignatureStatus(bytes: Buffer, signature: Buffer): 'match' | 'partial' | 'none' {
  const matched = matchedBytes(bytes, 0, signature)
  if (matched < 0) return 'none'
  return matched === signature.length ? 'match' : 'partial'
}

function detectFixedImage(bytes: Buffer): DetectionResult | undefined {
  const jpeg = fixedSignatureStatus(bytes, JPEG_SIGNATURE)
  if (jpeg === 'match') {
    return { status: 'recognized', mimeTypes: new Set<AllowedMimeType>(['image/jpeg']) }
  }
  if (jpeg === 'partial') return { status: 'truncated' }

  const png = fixedSignatureStatus(bytes, PNG_SIGNATURE)
  if (png === 'match') {
    return { status: 'recognized', mimeTypes: new Set<AllowedMimeType>(['image/png']) }
  }
  if (png === 'partial') return { status: 'truncated' }

  for (const signature of GIF_SIGNATURES) {
    const gif = fixedSignatureStatus(bytes, signature)
    if (gif === 'match') {
      return { status: 'recognized', mimeTypes: new Set<AllowedMimeType>(['image/gif']) }
    }
    if (gif === 'partial') return { status: 'truncated' }
  }
  return undefined
}

function detectWebp(bytes: Buffer): DetectionResult | undefined {
  const riff = fixedSignatureStatus(bytes, RIFF_SIGNATURE)
  if (riff === 'none') return undefined
  if (riff === 'partial' || bytes.length < 12) return { status: 'truncated' }

  if (matchedBytes(bytes, 8, WEBP_SIGNATURE) !== WEBP_SIGNATURE.length) {
    return { status: 'unrecognized' }
  }
  for (const chunkType of WEBP_CHUNK_TYPES) {
    const matched = matchedBytes(bytes, 12, chunkType)
    if (matched === chunkType.length) {
      return { status: 'recognized', mimeTypes: new Set<AllowedMimeType>(['image/webp']) }
    }
    if (matched >= 0) return { status: 'truncated' }
  }
  return { status: 'unrecognized' }
}

function readFtypLayout(bytes: Buffer):
  | {
      status: 'ftyp'
      majorBrandOffset: number
      compatibleBrandsOffset: number
      boxSize: number | undefined
    }
  | { status: 'truncated' }
  | { status: 'not-ftyp' } {
  if (bytes.length < 8) {
    if (bytes.length <= 4) return { status: 'not-ftyp' }
    const matched = matchedBytes(bytes, 4, FTYP_SIGNATURE)
    return matched >= 0 && matched < FTYP_SIGNATURE.length
      ? { status: 'truncated' }
      : { status: 'not-ftyp' }
  }
  if (matchedBytes(bytes, 4, FTYP_SIGNATURE) !== FTYP_SIGNATURE.length) {
    return { status: 'not-ftyp' }
  }

  const size32 = bytes.readUInt32BE(0)
  let headerBytes = 8
  let boxSize: number | undefined
  if (size32 === 1) {
    if (bytes.length < 16) return { status: 'truncated' }
    const largeSize = bytes.readBigUInt64BE(8)
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'not-ftyp' }
    boxSize = Number(largeSize)
    headerBytes = 16
  } else if (size32 !== 0) {
    boxSize = size32
  }

  const majorBrandOffset = headerBytes
  const compatibleBrandsOffset = majorBrandOffset + 8
  if (
    boxSize !== undefined &&
    (boxSize < compatibleBrandsOffset || (boxSize - compatibleBrandsOffset) % 4 !== 0)
  ) {
    return { status: 'not-ftyp' }
  }
  if (bytes.length < compatibleBrandsOffset) return { status: 'truncated' }
  return { status: 'ftyp', majorBrandOffset, compatibleBrandsOffset, boxSize }
}

function addBrandMimeTypes(mimeTypes: Set<AllowedMimeType>, brand: string): void {
  if (HEIC_BRANDS.has(brand)) mimeTypes.add('image/heic')
  if (brand === 'mif1' || brand === 'msf1') mimeTypes.add('image/heif')
  if (MP4_BRANDS.has(brand)) mimeTypes.add('video/mp4')
  if (brand === 'qt  ') mimeTypes.add('video/quicktime')
}

function detectIsoBmff(bytes: Buffer, totalBytes: number): DetectionResult | undefined {
  const layout = readFtypLayout(bytes)
  if (layout.status === 'not-ftyp') return undefined
  if (layout.status === 'truncated') return { status: 'truncated' }

  if (layout.boxSize !== undefined && layout.boxSize > totalBytes) {
    return { status: 'truncated' }
  }
  const availableEnd = Math.min(layout.boxSize ?? bytes.length, bytes.length)
  const mimeTypes = new Set<AllowedMimeType>()
  addBrandMimeTypes(
    mimeTypes,
    bytes.toString('latin1', layout.majorBrandOffset, layout.majorBrandOffset + 4),
  )
  for (let offset = layout.compatibleBrandsOffset; offset + 4 <= availableEnd; offset += 4) {
    const brand = bytes.toString('latin1', offset, offset + 4)
    addBrandMimeTypes(mimeTypes, brand)
  }
  if (mimeTypes.size > 0) return { status: 'recognized', mimeTypes }
  if (layout.boxSize === undefined || layout.boxSize > bytes.length) return { status: 'truncated' }
  return { status: 'unrecognized' }
}

function detect(bytes: Buffer, totalBytes: number): DetectionResult {
  const fixedImage = detectFixedImage(bytes)
  if (fixedImage !== undefined) return fixedImage

  const webp = detectWebp(bytes)
  if (webp !== undefined) return webp

  const isoBmff = detectIsoBmff(bytes, totalBytes)
  if (isoBmff !== undefined) return isoBmff

  return { status: 'unrecognized' }
}

export function validateFileSignature(
  prefix: Uint8Array,
  declaration: FileSignatureDeclaration,
  totalBytes = prefix.byteLength,
): FileSignatureValidationResult {
  const bytes = Buffer.from(prefix.subarray(0, FILE_SIGNATURE_PREFIX_BYTES))
  const result = detect(bytes, totalBytes)
  if (result.status === 'truncated') return { ok: false, reason: 'TRUNCATED' }
  if (result.status === 'unrecognized') return { ok: false, reason: 'UNRECOGNIZED' }

  if (
    !result.mimeTypes.has(declaration.mimeType) ||
    CANONICAL_EXTENSIONS[declaration.mimeType] !== declaration.canonicalExtension
  ) {
    return { ok: false, reason: 'DECLARATION_MISMATCH' }
  }
  return { ok: true }
}
