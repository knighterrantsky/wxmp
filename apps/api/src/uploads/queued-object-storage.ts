import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  ObjectStorageError,
  type MultipartIdentity,
  type ObjectStorage,
  type ObjectStorageHeadResult,
} from './object-storage.js'

const LOCAL_UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PART_NUMBER = /^[0-9]{5}$/u

interface SpoolManifest {
  readonly version: 1
  readonly bucket: string
  readonly key: string
  readonly contentType: string
  readonly metadata: Readonly<Record<string, string>>
  readonly initiatedAt: string
}

interface RemoteState {
  readonly version: 1
  readonly uploadId: string
  readonly parts: Readonly<Record<string, { readonly etag: string; readonly sizeBytes: number }>>
}

function storageError(
  operation: NonNullable<ObjectStorageError['operation']>,
  retryable = true,
): ObjectStorageError {
  return new ObjectStorageError({
    certainty: retryable ? 'ambiguous' : 'definite',
    code: 'SERVER_ERROR',
    operation,
    retryable,
  })
}

function definitiveMissing(error: unknown): boolean {
  return (
    error instanceof ObjectStorageError &&
    error.certainty === 'definite' &&
    error.code === 'NOT_FOUND'
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function decodedManifest(value: unknown): SpoolManifest | undefined {
  const candidate = record(value)
  const metadata = record(candidate?.['metadata'])
  if (
    candidate?.['version'] !== 1 ||
    typeof candidate['bucket'] !== 'string' ||
    typeof candidate['key'] !== 'string' ||
    typeof candidate['contentType'] !== 'string' ||
    typeof candidate['initiatedAt'] !== 'string' ||
    metadata === undefined ||
    !Object.values(metadata).every((item) => typeof item === 'string')
  ) {
    return undefined
  }
  return {
    version: 1,
    bucket: candidate['bucket'],
    key: candidate['key'],
    contentType: candidate['contentType'],
    metadata: metadata as Record<string, string>,
    initiatedAt: candidate['initiatedAt'],
  }
}

function decodedRemoteState(value: unknown): RemoteState | undefined {
  const candidate = record(value)
  const rawParts = record(candidate?.['parts'])
  if (candidate?.['version'] !== 1 || typeof candidate['uploadId'] !== 'string' || !rawParts) {
    return undefined
  }
  const parts: Record<string, { etag: string; sizeBytes: number }> = {}
  for (const [partNumber, raw] of Object.entries(rawParts)) {
    const part = record(raw)
    if (
      !/^[1-9][0-9]{0,4}$/u.test(partNumber) ||
      typeof part?.['etag'] !== 'string' ||
      !Number.isSafeInteger(part['sizeBytes']) ||
      Number(part['sizeBytes']) < 1
    ) {
      return undefined
    }
    parts[partNumber] = { etag: part['etag'], sizeBytes: Number(part['sizeBytes']) }
  }
  return { version: 1, uploadId: candidate['uploadId'], parts }
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await syncFile(temporary)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function partBase(partNumber: number): string {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw storageError('uploadPart', false)
  }
  return String(partNumber).padStart(5, '0')
}

export class LocalUploadSpool implements ObjectStorage {
  readonly #root: string

  constructor(input: { rootDirectory: string }) {
    if (!isAbsolute(input.rootDirectory) || input.rootDirectory.includes('\u0000')) {
      throw new TypeError('upload spool directory must be an absolute path')
    }
    this.#root = input.rootDirectory
  }

  async ready(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) return false
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      await access(this.#root, fsConstants.R_OK | fsConstants.W_OK)
      return true
    } catch {
      return false
    }
  }

  async createMultipart(input: {
    bucket: string
    key: string
    contentType: string
    metadata: Record<string, string>
    signal?: AbortSignal
  }): Promise<{ uploadId: string }> {
    if (input.signal?.aborted === true) throw storageError('createMultipart')
    const uploadId = randomUUID()
    const directory = this.#directory(uploadId)
    try {
      await mkdir(join(directory, 'parts'), { recursive: true, mode: 0o700 })
      await syncDirectory(this.#root)
      await syncDirectory(directory)
      await atomicJson(join(directory, 'manifest.json'), {
        version: 1,
        bucket: input.bucket,
        key: input.key,
        contentType: input.contentType,
        metadata: { ...input.metadata },
        initiatedAt: new Date().toISOString(),
      } satisfies SpoolManifest)
      return { uploadId }
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof ObjectStorageError) throw error
      throw storageError('createMultipart')
    }
  }

  async listMultipartUploads(input: {
    bucket: string
    prefix: string
    signal?: AbortSignal
  }): Promise<{ key: string; uploadId: string; initiatedAt?: Date }[]> {
    if (input.signal?.aborted === true) throw storageError('listMultipartUploads')
    const uploads: { key: string; uploadId: string; initiatedAt?: Date }[] = []
    let entries: string[]
    try {
      entries = await readdir(this.#root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw storageError('listMultipartUploads')
    }
    for (const uploadId of entries) {
      if (!LOCAL_UPLOAD_ID.test(uploadId)) continue
      const manifest = await this.manifest(uploadId).catch(() => undefined)
      if (manifest?.bucket !== input.bucket || !manifest.key.startsWith(input.prefix)) {
        continue
      }
      const initiatedAt = new Date(manifest.initiatedAt)
      uploads.push({
        key: manifest.key,
        uploadId,
        ...(Number.isFinite(initiatedAt.getTime()) ? { initiatedAt } : {}),
      })
    }
    return uploads
  }

  async uploadPart(input: {
    bucket: string
    key: string
    uploadId: string
    partNumber: number
    contentLength: number
    body: NodeJS.ReadableStream
    signal?: AbortSignal
  }): Promise<{ etag: string }> {
    const manifest = await this.manifest(input.uploadId)
    if (manifest.bucket !== input.bucket || manifest.key !== input.key) {
      throw storageError('uploadPart', false)
    }
    const base = partBase(input.partNumber)
    const directory = join(this.#directory(input.uploadId), 'parts')
    const temporary = join(directory, `${base}.${randomUUID()}.tmp`)
    const destination = join(directory, `${base}.bin`)
    let sizeBytes = 0
    const hash = createHash('sha256')
    const observer = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(
        input.body as NodeJS.ReadableStream & Readable,
        observer,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        ...(input.signal === undefined ? [] : [{ signal: input.signal }]),
      )
      if (sizeBytes !== input.contentLength) throw storageError('uploadPart', false)
      const etag = `spool-${hash.digest('hex')}`
      await syncFile(temporary)
      await rename(temporary, destination)
      await syncDirectory(directory)
      await atomicJson(join(directory, `${base}.json`), { etag, sizeBytes })
      return { etag }
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error
      throw storageError('uploadPart')
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async listParts(
    input: MultipartIdentity & { signal?: AbortSignal },
  ): Promise<{ partNumber: number; etag: string; sizeBytes: number }[]> {
    const manifest = await this.manifest(input.uploadId)
    if (manifest.bucket !== input.bucket || manifest.key !== input.key) {
      throw storageError('listParts', false)
    }
    const directory = join(this.#directory(input.uploadId), 'parts')
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      throw storageError('listParts')
    }
    const parts: { partNumber: number; etag: string; sizeBytes: number }[] = []
    for (const entry of entries.sort()) {
      const match = /^(?<number>[0-9]{5})\.json$/u.exec(entry)
      const partNumberText = match?.groups?.['number']
      if (partNumberText === undefined || !PART_NUMBER.test(partNumberText)) continue
      const metadata = record(await jsonFile(join(directory, entry)).catch(() => undefined))
      const etag = metadata?.['etag']
      const sizeBytes = metadata?.['sizeBytes']
      if (typeof etag !== 'string' || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1) {
        throw storageError('listParts', false)
      }
      const partNumber = Number(partNumberText)
      const file = await stat(join(directory, `${partNumberText}.bin`)).catch(() => undefined)
      if (!file?.isFile() || file.size !== Number(sizeBytes)) throw storageError('listParts', false)
      parts.push({ partNumber, etag, sizeBytes: Number(sizeBytes) })
    }
    return parts
  }

  completeMultipart(): Promise<{ etag: string }> {
    return Promise.reject(storageError('completeMultipart', false))
  }

  async abortMultipart(input: MultipartIdentity): Promise<void> {
    await this.remove(input.uploadId)
  }

  headObject(): Promise<ObjectStorageHeadResult | null> {
    return Promise.resolve(null)
  }

  async manifest(uploadId: string): Promise<SpoolManifest> {
    const manifest = decodedManifest(
      await jsonFile(join(this.#directory(uploadId), 'manifest.json')),
    )
    if (!manifest) throw storageError('listParts', false)
    return manifest
  }

  partPath(uploadId: string, partNumber: number): string {
    return join(this.#directory(uploadId), 'parts', `${partBase(partNumber)}.bin`)
  }

  async remoteState(uploadId: string): Promise<RemoteState | undefined> {
    try {
      const state = decodedRemoteState(
        await jsonFile(join(this.#directory(uploadId), 'remote.json')),
      )
      if (!state) throw storageError('listParts', false)
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async saveRemoteState(uploadId: string, state: RemoteState): Promise<void> {
    await atomicJson(join(this.#directory(uploadId), 'remote.json'), state)
  }

  async remove(uploadId: string): Promise<void> {
    await rm(this.#directory(uploadId), { recursive: true, force: true })
    await syncDirectory(this.#root).catch(() => undefined)
  }

  async removeCompletedObject(
    bucket: string,
    key: string,
    object: ObjectStorageHeadResult,
  ): Promise<void> {
    const uploads = await this.listMultipartUploads({ bucket, prefix: key })
    for (const upload of uploads.filter((candidate) => candidate.key === key)) {
      const manifest = await this.manifest(upload.uploadId).catch(() => undefined)
      const parts = await this.listParts({ bucket, key, uploadId: upload.uploadId }).catch(
        () => undefined,
      )
      if (!manifest || !parts) continue
      const sizeBytes = parts.reduce((sum, part) => sum + part.sizeBytes, 0)
      if (
        object.etag === undefined ||
        sizeBytes !== object.sizeBytes ||
        object.contentType !== manifest.contentType ||
        object.metadata?.mediaId !== manifest.metadata['mediaId'] ||
        object.metadata?.userId !== manifest.metadata['userId']
      ) {
        continue
      }
      await this.remove(upload.uploadId)
    }
  }

  #directory(uploadId: string): string {
    if (!LOCAL_UPLOAD_ID.test(uploadId)) throw storageError('listParts', false)
    return join(this.#root, uploadId)
  }
}

export class QueuedR2ObjectStorage implements ObjectStorage {
  readonly #spool: LocalUploadSpool
  readonly #remote: ObjectStorage

  constructor(input: { spool: LocalUploadSpool; remote: ObjectStorage }) {
    this.#spool = input.spool
    this.#remote = input.remote
  }

  ready(signal?: AbortSignal): Promise<boolean> {
    return this.#remote.ready(signal)
  }

  createMultipart(input: Parameters<ObjectStorage['createMultipart']>[0]) {
    return this.#spool.createMultipart(input)
  }

  listMultipartUploads(input: Parameters<ObjectStorage['listMultipartUploads']>[0]) {
    return this.#spool.listMultipartUploads(input)
  }

  uploadPart(input: Parameters<ObjectStorage['uploadPart']>[0]) {
    return this.#spool.uploadPart(input)
  }

  async listParts(
    input: MultipartIdentity & { signal?: AbortSignal },
  ): Promise<{ partNumber: number; etag: string; sizeBytes: number }[]> {
    const localParts = await this.#spool.listParts(input)
    const manifest = await this.#spool.manifest(input.uploadId)
    let state = await this.#spool.remoteState(input.uploadId)
    state ??= await this.#createOrAdoptRemote(input, manifest)

    let existing: Awaited<ReturnType<ObjectStorage['listParts']>>
    try {
      existing = await this.#remote.listParts({
        bucket: input.bucket,
        key: input.key,
        uploadId: state.uploadId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      if (!definitiveMissing(error)) throw error
      state = await this.#createOrAdoptRemote(input, manifest, state.uploadId)
      existing = await this.#remote.listParts({
        bucket: input.bucket,
        key: input.key,
        uploadId: state.uploadId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    }
    const remoteByNumber = new Map(existing.map((part) => [part.partNumber, part]))
    const nextParts: Record<string, { etag: string; sizeBytes: number }> = { ...state.parts }
    for (const part of localParts) {
      let remotePart = remoteByNumber.get(part.partNumber)
      if (remotePart?.sizeBytes !== part.sizeBytes) {
        remotePart = await this.#remote
          .uploadPart({
            bucket: input.bucket,
            key: input.key,
            uploadId: state.uploadId,
            partNumber: part.partNumber,
            contentLength: part.sizeBytes,
            body: createReadStream(this.#spool.partPath(input.uploadId, part.partNumber)),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
          .then((uploaded) => ({
            ...uploaded,
            partNumber: part.partNumber,
            sizeBytes: part.sizeBytes,
          }))
      }
      if (!remotePart) throw storageError('uploadPart')
      nextParts[String(part.partNumber)] = {
        etag: remotePart.etag,
        sizeBytes: remotePart.sizeBytes,
      }
      await this.#spool.saveRemoteState(input.uploadId, {
        version: 1,
        uploadId: state.uploadId,
        parts: nextParts,
      })
    }
    return localParts
  }

  async completeMultipart(
    input: MultipartIdentity & {
      parts: { partNumber: number; etag: string }[]
      signal?: AbortSignal
    },
  ): Promise<{ etag: string }> {
    const state = await this.#spool.remoteState(input.uploadId)
    if (!state) throw storageError('completeMultipart')
    const remoteParts = input.parts.map((part) => {
      const remote = state.parts[String(part.partNumber)]
      if (!remote) throw storageError('completeMultipart')
      return { partNumber: part.partNumber, etag: remote.etag }
    })
    return this.#remote.completeMultipart({
      bucket: input.bucket,
      key: input.key,
      uploadId: state.uploadId,
      parts: remoteParts,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async abortMultipart(input: MultipartIdentity & { signal?: AbortSignal }): Promise<void> {
    const state = await this.#spool.remoteState(input.uploadId).catch(() => undefined)
    if (state) {
      await this.#remote.abortMultipart({
        bucket: input.bucket,
        key: input.key,
        uploadId: state.uploadId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    }
    await this.#spool.remove(input.uploadId)
  }

  async headObject(input: {
    bucket: string
    key: string
    signal?: AbortSignal
  }): Promise<ObjectStorageHeadResult | null> {
    const object = await this.#remote.headObject(input)
    if (object) {
      await this.#spool
        .removeCompletedObject(input.bucket, input.key, object)
        .catch(() => undefined)
    }
    return object
  }

  async #createOrAdoptRemote(
    input: MultipartIdentity & { signal?: AbortSignal },
    manifest: SpoolManifest,
    excludedUploadId?: string,
  ): Promise<RemoteState> {
    const candidates = await this.#remote.listMultipartUploads({
      bucket: input.bucket,
      prefix: input.key,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const adopted = candidates
      .filter((candidate) => candidate.key === input.key && candidate.uploadId !== excludedUploadId)
      .sort((left, right) => {
        const leftTime = left.initiatedAt?.getTime() ?? Number.MAX_SAFE_INTEGER
        const rightTime = right.initiatedAt?.getTime() ?? Number.MAX_SAFE_INTEGER
        return leftTime - rightTime || left.uploadId.localeCompare(right.uploadId)
      })[0]
    const uploadId =
      adopted?.uploadId ??
      (
        await this.#remote.createMultipart({
          bucket: input.bucket,
          key: input.key,
          contentType: manifest.contentType,
          metadata: { ...manifest.metadata },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      ).uploadId
    const state: RemoteState = { version: 1, uploadId, parts: {} }
    await this.#spool.saveRemoteState(input.uploadId, state)
    return state
  }
}
