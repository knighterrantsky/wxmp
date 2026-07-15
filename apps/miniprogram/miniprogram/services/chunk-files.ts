import { MAX_PART_COUNT, PART_SIZE_BYTES, type UploadPartPlan } from '@wx-upload/contracts'

import { sha256Hex } from '../core/sha256.js'
import type { WechatFileRuntime } from '../runtime/wx-files.js'

export const CHUNK_FILE_PREFIX = 'wx-upload-private-chunk-v1-'

const MAX_ACTIVE_CHUNKS = 2
const MAX_PATH_LENGTH = 4096
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u
const OWNED_FILE_PATTERN = new RegExp(`^${CHUNK_FILE_PREFIX}[a-z0-9][a-z0-9_-]{0,127}\\.part$`, 'u')

let nextDefaultId = 0

function defaultId(): string {
  nextDefaultId = (nextDefaultId + 1) % Number.MAX_SAFE_INTEGER
  const random = Math.floor(Math.random() * 0x1_0000_0000)
  return `${Date.now().toString(36)}-${random.toString(36)}-${nextDefaultId.toString(36)}`
}

export type ChunkFileErrorCode =
  | 'INVALID_INPUT'
  | 'RESOURCE_LIMIT'
  | 'SHORT_READ'
  | 'CREATE_FAILED'
  | 'DELETE_FAILED'
  | 'CLEANUP_FAILED'

const ERROR_MESSAGES: Record<ChunkFileErrorCode, string> = {
  INVALID_INPUT: '分片文件参数无效',
  RESOURCE_LIMIT: '同时处理的分片过多',
  SHORT_READ: '源文件分片读取不完整',
  CREATE_FAILED: '分片文件创建失败',
  DELETE_FAILED: '分片文件删除失败',
  CLEANUP_FAILED: '遗留分片清理失败',
}

export class ChunkFileError extends Error {
  readonly code: ChunkFileErrorCode

  constructor(code: ChunkFileErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ChunkFileError'
    this.code = code
  }
}

export interface ChunkFile {
  readonly partNumber: number
  readonly sizeBytes: number
  readonly sha256: string
  readonly tempPath: string
}

export interface ChunkFileServiceOptions {
  files: WechatFileRuntime
  userDataPath: string
  maximumActiveChunks?: number
  createId?: () => string
}

interface PartSnapshot {
  partNumber: number
  offsetBytes: number
  sizeBytes: number
}

function safeRoot(userDataPath: string): string {
  if (
    userDataPath.length < 1 ||
    userDataPath.length > MAX_PATH_LENGTH ||
    userDataPath.includes('\u0000')
  ) {
    throw new ChunkFileError('INVALID_INPUT')
  }
  const root = userDataPath.replace(/\/+$/u, '')
  if (root.length === 0) throw new ChunkFileError('INVALID_INPUT')
  return root
}

function snapshotPart(part: UploadPartPlan): PartSnapshot {
  if (
    !Number.isSafeInteger(part.partNumber) ||
    part.partNumber < 1 ||
    part.partNumber > MAX_PART_COUNT ||
    !Number.isSafeInteger(part.offsetBytes) ||
    part.offsetBytes < 0 ||
    !Number.isSafeInteger(part.sizeBytes) ||
    part.sizeBytes < 1 ||
    part.sizeBytes > PART_SIZE_BYTES ||
    !Number.isSafeInteger(part.offsetBytes + part.sizeBytes)
  ) {
    throw new ChunkFileError('INVALID_INPUT')
  }
  return {
    partNumber: part.partNumber,
    offsetBytes: part.offsetBytes,
    sizeBytes: part.sizeBytes,
  }
}

function assertSourcePath(sourcePath: string): void {
  if (
    sourcePath.length < 1 ||
    sourcePath.length > MAX_PATH_LENGTH ||
    sourcePath.includes('\u0000')
  ) {
    throw new ChunkFileError('INVALID_INPUT')
  }
}

export class ChunkFileService {
  readonly #files: WechatFileRuntime
  readonly #root: string
  readonly #maximumActiveChunks: number
  readonly #createId: () => string
  readonly #active = new Map<string, ChunkFile>()
  readonly #reservedPaths = new Set<string>()
  #allocatedCount = 0

  constructor(options: ChunkFileServiceOptions) {
    this.#root = safeRoot(options.userDataPath)
    const maximum = options.maximumActiveChunks ?? MAX_ACTIVE_CHUNKS
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ACTIVE_CHUNKS) {
      throw new ChunkFileError('INVALID_INPUT')
    }
    this.#files = options.files
    this.#maximumActiveChunks = maximum
    this.#createId = options.createId ?? defaultId
  }

  get activeCount(): number {
    return this.#allocatedCount
  }

  get maximumActiveChunks(): number {
    return this.#maximumActiveChunks
  }

  async create(sourcePath: string, part: UploadPartPlan): Promise<ChunkFile> {
    assertSourcePath(sourcePath)
    const expected = snapshotPart(part)
    if (this.#allocatedCount >= this.#maximumActiveChunks) {
      throw new ChunkFileError('RESOURCE_LIMIT')
    }
    this.#allocatedCount += 1

    let tempPath: string
    try {
      const id = this.#createId()
      if (!SAFE_ID_PATTERN.test(id)) throw new ChunkFileError('INVALID_INPUT')
      tempPath = `${this.#root}/${CHUNK_FILE_PREFIX}${id}.part`
      if (this.#reservedPaths.has(tempPath)) throw new ChunkFileError('CREATE_FAILED')
      this.#reservedPaths.add(tempPath)
    } catch (error) {
      this.#allocatedCount -= 1
      if (error instanceof ChunkFileError) throw error
      throw new ChunkFileError('INVALID_INPUT')
    }

    let writeAttempted = false
    try {
      const fd = await this.#files.openRead(sourcePath)
      let bytes: Uint8Array
      try {
        bytes = await this.#files.read(fd, expected.offsetBytes, expected.sizeBytes)
      } finally {
        await this.#files.close(fd)
      }
      if (bytes.byteLength !== expected.sizeBytes) throw new ChunkFileError('SHORT_READ')

      const digest = sha256Hex(bytes)
      writeAttempted = true
      await this.#files.writeFile(tempPath, bytes)
      const chunk: ChunkFile = Object.freeze({
        partNumber: expected.partNumber,
        sizeBytes: expected.sizeBytes,
        sha256: digest,
        tempPath,
      })
      this.#active.set(tempPath, chunk)
      return chunk
    } catch (error) {
      if (writeAttempted) {
        try {
          await this.#files.unlink(tempPath)
        } catch {
          // Startup cleanup retries safe, prefix-owned leftovers.
        }
      }
      this.#reservedPaths.delete(tempPath)
      this.#allocatedCount -= 1
      if (error instanceof ChunkFileError) throw error
      throw new ChunkFileError('CREATE_FAILED')
    }
  }

  acknowledge(chunk: ChunkFile): Promise<void> {
    return this.delete(chunk)
  }

  async delete(chunk: ChunkFile): Promise<void> {
    const active = this.#active.get(chunk.tempPath)
    if (active === undefined) return
    if (
      active.partNumber !== chunk.partNumber ||
      active.sizeBytes !== chunk.sizeBytes ||
      active.sha256 !== chunk.sha256
    ) {
      throw new ChunkFileError('INVALID_INPUT')
    }
    try {
      await this.#files.unlink(active.tempPath)
    } catch {
      throw new ChunkFileError('DELETE_FAILED')
    }
    this.#active.delete(active.tempPath)
    this.#reservedPaths.delete(active.tempPath)
    this.#allocatedCount -= 1
  }

  async cleanupOrphans(): Promise<{ removed: number }> {
    let entries: string[]
    try {
      entries = await this.#files.listDirectory(this.#root)
    } catch {
      throw new ChunkFileError('CLEANUP_FAILED')
    }

    let removed = 0
    let failed = false
    for (const name of new Set(entries)) {
      if (!OWNED_FILE_PATTERN.test(name)) continue
      const path = `${this.#root}/${name}`
      if (this.#reservedPaths.has(path)) continue
      try {
        await this.#files.unlink(path)
        removed += 1
      } catch {
        failed = true
      }
    }
    if (failed) throw new ChunkFileError('CLEANUP_FAILED')
    return { removed }
  }
}
