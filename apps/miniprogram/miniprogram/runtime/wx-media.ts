export type WechatMediaSelectionErrorCode = 'CANCELLED' | 'FAILED' | 'INVALID_RESPONSE'

export class WechatMediaSelectionError extends Error {
  override readonly name = 'WechatMediaSelectionError'
  readonly code: WechatMediaSelectionErrorCode

  constructor(code: WechatMediaSelectionErrorCode) {
    super(
      code === 'CANCELLED'
        ? 'WeChat media selection was cancelled'
        : code === 'INVALID_RESPONSE'
          ? 'WeChat media selection response was invalid'
          : 'WeChat media selection failed',
    )
    this.code = code
  }
}

export interface WechatSelectedMedia {
  readonly sourcePath: string
  readonly previewPath: string
  readonly sizeBytes: number
  readonly kind: 'image' | 'video'
}

export interface WechatMediaRuntime {
  chooseMedia(maxCount?: number): Promise<WechatSelectedMedia[]>
}

export interface WxChooseMediaOptions {
  count: number
  mediaType: ['image', 'video']
  success(result: unknown): void
  fail(reason: unknown): void
}

export interface WxChooseMediaSource {
  chooseMedia(options: WxChooseMediaOptions): unknown
}

const MAX_MEDIA_COUNT = 9
const MAX_PATH_CHARACTERS = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMediaKind(value: unknown): value is WechatSelectedMedia['kind'] {
  return value === 'image' || value === 'video'
}

function validLocalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_PATH_CHARACTERS &&
    !value.includes('\u0000')
  )
}

function normalizeFile(value: unknown): WechatSelectedMedia {
  if (!isRecord(value)) throw new WechatMediaSelectionError('INVALID_RESPONSE')

  const sourcePath = value['tempFilePath']
  const sizeBytes = value['size']
  const kind = value['fileType']
  if (
    !validLocalPath(sourcePath) ||
    typeof sizeBytes !== 'number' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !isMediaKind(kind)
  ) {
    throw new WechatMediaSelectionError('INVALID_RESPONSE')
  }

  const thumbnail = value['thumbTempFilePath']
  const previewPath = kind === 'video' && validLocalPath(thumbnail) ? thumbnail : sourcePath
  return { sourcePath, previewPath, sizeBytes, kind }
}

function normalizeSelection(value: unknown): WechatSelectedMedia[] {
  if (!isRecord(value)) throw new WechatMediaSelectionError('INVALID_RESPONSE')
  if (value['errMsg'] !== 'chooseMedia:ok') {
    throw new WechatMediaSelectionError('INVALID_RESPONSE')
  }

  const aggregateType = value['type']
  if (aggregateType !== 'image' && aggregateType !== 'video' && aggregateType !== 'mix') {
    throw new WechatMediaSelectionError('INVALID_RESPONSE')
  }

  const tempFiles = value['tempFiles']
  if (!Array.isArray(tempFiles) || tempFiles.length < 1 || tempFiles.length > MAX_MEDIA_COUNT) {
    throw new WechatMediaSelectionError('INVALID_RESPONSE')
  }

  const selected = tempFiles.map(normalizeFile)
  if (aggregateType !== 'mix' && selected.some((file) => file.kind !== aggregateType)) {
    throw new WechatMediaSelectionError('INVALID_RESPONSE')
  }
  return selected
}

function isCancellation(reason: unknown): boolean {
  return isRecord(reason) && reason['errMsg'] === 'chooseMedia:fail cancel'
}

export function chooseMediaWithWechatRuntime(
  source: WxChooseMediaSource,
  maxCount = MAX_MEDIA_COUNT,
): Promise<WechatSelectedMedia[]> {
  if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > MAX_MEDIA_COUNT) {
    return Promise.reject(new RangeError('maxCount must be an integer between 1 and 9'))
  }
  return new Promise((resolve, reject) => {
    try {
      source.chooseMedia({
        count: maxCount,
        mediaType: ['image', 'video'],
        success(result) {
          try {
            resolve(normalizeSelection(result))
          } catch {
            reject(new WechatMediaSelectionError('INVALID_RESPONSE'))
          }
        },
        fail(reason) {
          try {
            reject(new WechatMediaSelectionError(isCancellation(reason) ? 'CANCELLED' : 'FAILED'))
          } catch {
            reject(new WechatMediaSelectionError('FAILED'))
          }
        },
      })
    } catch {
      reject(new WechatMediaSelectionError('FAILED'))
    }
  })
}
