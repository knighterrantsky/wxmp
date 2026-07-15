import { describe, expect, it, vi } from 'vitest'

import {
  createWechatFileRuntime,
  type WechatFileRuntime,
  type WxFileSystemManagerSource,
} from '../miniprogram/runtime/wx-files.js'
import {
  CHUNK_FILE_PREFIX,
  ChunkFileError,
  ChunkFileService,
} from '../miniprogram/services/chunk-files.js'

const USER_DATA_PATH = 'wxfile://usr'

function plan(sizeBytes: number, offsetBytes = 0, partNumber = 1) {
  return { partNumber, offsetBytes, sizeBytes }
}

interface MemoryFiles extends WechatFileRuntime {
  source: Uint8Array
  written: Map<string, Uint8Array>
  directoryEntries: string[]
  openRead: ReturnType<typeof vi.fn<WechatFileRuntime['openRead']>>
  read: ReturnType<typeof vi.fn<WechatFileRuntime['read']>>
  close: ReturnType<typeof vi.fn<WechatFileRuntime['close']>>
  writeFile: ReturnType<typeof vi.fn<WechatFileRuntime['writeFile']>>
  unlink: ReturnType<typeof vi.fn<WechatFileRuntime['unlink']>>
  listDirectory: ReturnType<typeof vi.fn<WechatFileRuntime['listDirectory']>>
}

function memoryFiles(source: Uint8Array): MemoryFiles {
  const written = new Map<string, Uint8Array>()
  const directoryEntries: string[] = []
  const openRead = vi.fn<WechatFileRuntime['openRead']>().mockResolvedValue('source-fd')
  const read = vi.fn<WechatFileRuntime['read']>((_fd, position, length) =>
    Promise.resolve(source.slice(position, position + length)),
  )
  const close = vi.fn<WechatFileRuntime['close']>().mockResolvedValue(undefined)
  const writeFile = vi.fn<WechatFileRuntime['writeFile']>((path, data) => {
    written.set(path, data.slice())
    return Promise.resolve()
  })
  const unlink = vi.fn<WechatFileRuntime['unlink']>((path) => {
    written.delete(path)
    return Promise.resolve()
  })
  const listDirectory = vi
    .fn<WechatFileRuntime['listDirectory']>()
    .mockImplementation(() => Promise.resolve([...directoryEntries]))
  return {
    source,
    written,
    directoryEntries,
    openRead,
    read,
    close,
    writeFile,
    unlink,
    listDirectory,
  }
}

function serviceFixture(source: Uint8Array, maximumActiveChunks = 2) {
  const files = memoryFiles(source)
  let sequence = 0
  const service = new ChunkFileService({
    files,
    userDataPath: USER_DATA_PATH,
    maximumActiveChunks,
    createId: () => `fixture-${String(++sequence)}`,
  })
  return { files, service }
}

describe('WeChat FileSystemManager adapter', () => {
  it('opens and reads only the requested position and length into a bounded buffer', async () => {
    const open = vi.fn<WxFileSystemManagerSource['open']>((options) => {
      options.success({ fd: 'fd-1' })
    })
    const read = vi.fn<WxFileSystemManagerSource['read']>((options) => {
      new Uint8Array(options.arrayBuffer).set([0xaa, 0xbb, 0xcc])
      options.success({ bytesRead: 3, arrayBuffer: options.arrayBuffer })
    })
    const manager: WxFileSystemManagerSource = {
      open,
      read,
      close: vi.fn(),
      writeFile: vi.fn(),
      unlink: vi.fn(),
      readdir: vi.fn(),
    }
    const runtime = createWechatFileRuntime(manager)

    const fd = await runtime.openRead('wxfile://tmp/source.mp4')
    await expect(runtime.read(fd, 8_388_608, 3)).resolves.toEqual(
      Uint8Array.from([0xaa, 0xbb, 0xcc]),
    )

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'wxfile://tmp/source.mp4', flag: 'r' }),
    )
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        fd: 'fd-1',
        offset: 0,
        position: 8_388_608,
        length: 3,
      }),
    )
    const readOptions = read.mock.calls[0]?.[0]
    expect(readOptions?.arrayBuffer).toBeInstanceOf(ArrayBuffer)
    expect(readOptions?.arrayBuffer.byteLength).toBe(3)
    expect(manager).not.toHaveProperty('readFile')
  })

  it('maps write, close, unlink and directory operations without exposing paths in failures', async () => {
    const close = vi.fn<WxFileSystemManagerSource['close']>((options) => {
      options.success()
    })
    const writeFile = vi.fn<WxFileSystemManagerSource['writeFile']>((options) => {
      options.success()
    })
    const unlink = vi.fn<WxFileSystemManagerSource['unlink']>((options) => {
      options.success()
    })
    const readdir = vi.fn<WxFileSystemManagerSource['readdir']>((options) => {
      options.success({ files: ['one.part'] })
    })
    const manager: WxFileSystemManagerSource = {
      open: vi.fn(),
      read: vi.fn(),
      close,
      writeFile,
      unlink,
      readdir,
    }
    const runtime = createWechatFileRuntime(manager)

    await runtime.close('fd-1')
    await runtime.writeFile('wxfile://usr/chunk.part', Uint8Array.from([1, 2, 3]))
    await runtime.unlink('wxfile://usr/chunk.part')
    await expect(runtime.listDirectory(USER_DATA_PATH)).resolves.toEqual(['one.part'])

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ fd: 'fd-1' }))
    const writeOptions = writeFile.mock.calls[0]?.[0]
    expect(new Uint8Array(writeOptions?.data ?? new ArrayBuffer(0))).toEqual(
      Uint8Array.from([1, 2, 3]),
    )
    expect(unlink).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'wxfile://usr/chunk.part' }),
    )
    expect(readdir).toHaveBeenCalledWith(expect.objectContaining({ dirPath: USER_DATA_PATH }))

    const rawFailure = 'wxfile://private/source token-secret raw filesystem text'
    const failed = createWechatFileRuntime({
      ...manager,
      open: (options) => {
        options.fail({ errMsg: rawFailure })
      },
    })
    const error = await failed.openRead(rawFailure).catch((failure: unknown) => failure)
    expect(String(error)).toContain('file open failed')
    expect(String(error)).not.toContain(rawFailure)
  })
})

describe('ChunkFileService', () => {
  it('hashes the requested bytes with the standard lowercase SHA-256 vector', async () => {
    const source = Uint8Array.from([0x61, 0x62, 0x63])
    const { files, service } = serviceFixture(source)
    const requestedPart = Object.freeze(plan(3))

    const chunk = await service.create('wxfile://tmp/original-token-secret.mov', requestedPart)

    expect(chunk).toEqual({
      partNumber: 1,
      sizeBytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      tempPath: `${USER_DATA_PATH}/${CHUNK_FILE_PREFIX}fixture-1.part`,
    })
    expect(files.openRead).toHaveBeenCalledWith('wxfile://tmp/original-token-secret.mov')
    expect(files.read).toHaveBeenCalledWith('source-fd', 0, 3)
    expect(files.close).toHaveBeenCalledWith('source-fd')
    expect(files.written.get(chunk.tempPath)).toEqual(source)
    expect(chunk.tempPath).not.toMatch(/original|token-secret|\.mov/u)
    expect(requestedPart).toEqual(plan(3))
  })

  it('hashes without DataView BigInt64 methods required by newer Node runtimes', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(DataView.prototype, 'setBigUint64')
    Object.defineProperty(DataView.prototype, 'setBigUint64', {
      configurable: true,
      value: undefined,
    })
    try {
      const { service } = serviceFixture(Uint8Array.from([0x61, 0x62, 0x63]))

      await expect(service.create('wxfile://tmp/source.jpg', plan(3))).resolves.toMatchObject({
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      })
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(DataView.prototype, 'setBigUint64')
      } else {
        Object.defineProperty(DataView.prototype, 'setBigUint64', descriptor)
      }
    }
  })

  it('uses the exact offset and does not hash bytes outside the requested range', async () => {
    const source = Uint8Array.from([9, 8, 0x61, 0x62, 0x63, 7])
    const { files, service } = serviceFixture(source)

    const chunk = await service.create('wxfile://tmp/source', plan(3, 2, 2))

    expect(files.read).toHaveBeenCalledWith('source-fd', 2, 3)
    expect(chunk.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(files.written.get(chunk.tempPath)).toEqual(Uint8Array.from([0x61, 0x62, 0x63]))
  })

  it.each([11, 12])('supports a %s-byte boundary chunk without widening the read', async (size) => {
    const { files, service } = serviceFixture(new Uint8Array(size).fill(0x5a))

    const chunk = await service.create('wxfile://tmp/source', plan(size))

    expect(chunk.sizeBytes).toBe(size)
    expect(chunk.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(files.read).toHaveBeenCalledWith('source-fd', 0, size)
  })

  it('supports one exact 8 MiB chunk with a single bounded read', async () => {
    const size = 8_388_608
    const { files, service } = serviceFixture(new Uint8Array(size).fill(0xa5))

    const chunk = await service.create('wxfile://tmp/source', plan(size))

    expect(chunk.sizeBytes).toBe(size)
    expect(files.read).toHaveBeenCalledOnce()
    expect(files.read).toHaveBeenCalledWith('source-fd', 0, size)
    expect(files.written.get(chunk.tempPath)?.byteLength).toBe(size)
  })

  it('rejects a short read, closes the source and never writes a partial chunk', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12))
    files.read.mockResolvedValueOnce(new Uint8Array(11))

    await expect(service.create('wxfile://tmp/source', plan(12))).rejects.toMatchObject({
      code: 'SHORT_READ',
    })

    expect(files.close).toHaveBeenCalledWith('source-fd')
    expect(files.writeFile).not.toHaveBeenCalled()
    expect(service.activeCount).toBe(0)
  })

  it.each(['open', 'read', 'close'] as const)(
    'closes what it can and safely fails when source %s fails',
    async (stage) => {
      const { files, service } = serviceFixture(new Uint8Array(12))
      const raw = new Error(`raw ${stage} wxfile://private token-secret`)
      if (stage === 'open') files.openRead.mockRejectedValueOnce(raw)
      if (stage === 'read') files.read.mockRejectedValueOnce(raw)
      if (stage === 'close') files.close.mockRejectedValueOnce(raw)

      const error = await service
        .create('wxfile://tmp/private-name.mov', plan(12))
        .catch((failure: unknown) => failure)

      expect(error).toBeInstanceOf(ChunkFileError)
      expect(String(error)).not.toMatch(/private-name|token-secret|wxfile/u)
      expect(files.close).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1)
      expect(files.writeFile).not.toHaveBeenCalled()
      expect(service.activeCount).toBe(0)
    },
  )

  it('attempts to unlink a possible partial file after a write failure', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12))
    files.writeFile.mockRejectedValueOnce(new Error('raw write path'))

    await expect(service.create('wxfile://tmp/source', plan(12))).rejects.toMatchObject({
      code: 'CREATE_FAILED',
    })

    expect(files.unlink).toHaveBeenCalledWith(
      `${USER_DATA_PATH}/${CHUNK_FILE_PREFIX}fixture-1.part`,
    )
    expect(service.activeCount).toBe(0)
  })

  it('does not leak a cleanup failure when write and unlink both fail', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12))
    files.writeFile.mockRejectedValueOnce(new Error('write wxfile://secret'))
    files.unlink.mockRejectedValueOnce(new Error('unlink token-secret'))

    const error = await service
      .create('wxfile://tmp/source', plan(12))
      .catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'CREATE_FAILED' })
    expect(String(error)).not.toMatch(/wxfile|token-secret/u)
    expect(service.activeCount).toBe(0)
  })

  it('deletes an acknowledged chunk, releases capacity and is idempotent', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12), 1)
    const first = await service.create('wxfile://tmp/source', plan(12))
    expect(service.activeCount).toBe(1)

    await service.acknowledge(first)
    await service.acknowledge(first)

    expect(files.unlink).toHaveBeenCalledOnce()
    expect(files.written.has(first.tempPath)).toBe(false)
    expect(service.activeCount).toBe(0)
    await expect(service.create('wxfile://tmp/source', plan(12))).resolves.toBeDefined()
  })

  it('keeps a chunk active after unlink failure so deletion can be retried', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12), 1)
    const chunk = await service.create('wxfile://tmp/source', plan(12))
    files.unlink.mockRejectedValueOnce(new Error('raw unlink private path'))

    await expect(service.delete(chunk)).rejects.toMatchObject({ code: 'DELETE_FAILED' })
    expect(service.activeCount).toBe(1)

    await service.delete(chunk)
    expect(service.activeCount).toBe(0)
  })

  it('enforces the configured active chunk limit until one is deleted', async () => {
    const { files, service } = serviceFixture(new Uint8Array(24), 2)
    const first = await service.create('wxfile://tmp/source', plan(12, 0, 1))
    await service.create('wxfile://tmp/source', plan(12, 12, 2))

    await expect(service.create('wxfile://tmp/source', plan(12))).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
    })
    expect(files.openRead).toHaveBeenCalledTimes(2)

    await service.delete(first)
    await expect(service.create('wxfile://tmp/source', plan(12))).resolves.toBeDefined()
  })

  it('rejects a generated path collision without corrupting active capacity', async () => {
    const files = memoryFiles(new Uint8Array(24))
    const service = new ChunkFileService({
      files,
      userDataPath: USER_DATA_PATH,
      maximumActiveChunks: 2,
      createId: () => 'same-id',
    })
    const first = await service.create('wxfile://tmp/source', plan(12, 0, 1))

    await expect(service.create('wxfile://tmp/source', plan(12, 12, 2))).rejects.toMatchObject({
      code: 'CREATE_FAILED',
    })

    expect(service.activeCount).toBe(1)
    await service.delete(first)
    expect(service.activeCount).toBe(0)
  })

  it('cleans only safe orphan names under the private prefix and skips active chunks', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12))
    const active = await service.create('wxfile://tmp/source', plan(12))
    files.directoryEntries.push(
      active.tempPath.slice(`${USER_DATA_PATH}/`.length),
      `${CHUNK_FILE_PREFIX}orphan-1.part`,
      `${CHUNK_FILE_PREFIX}../escape.part`,
      `../${CHUNK_FILE_PREFIX}outside.part`,
      'user-photo.jpg',
    )

    const result = await service.cleanupOrphans()

    expect(result).toEqual({ removed: 1 })
    expect(files.unlink).toHaveBeenCalledWith(`${USER_DATA_PATH}/${CHUNK_FILE_PREFIX}orphan-1.part`)
    expect(files.unlink).not.toHaveBeenCalledWith(active.tempPath)
    expect(files.unlink.mock.calls.flat()).not.toContain('../')
  })

  it('does not clean a reserved path while its bounded write is still in progress', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12))
    let finishWrite: (() => void) | undefined
    files.writeFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = resolve
        }),
    )
    const creating = service.create('wxfile://tmp/source', plan(12))
    await vi.waitFor(() => {
      expect(files.writeFile).toHaveBeenCalledOnce()
    })
    files.directoryEntries.push(`${CHUNK_FILE_PREFIX}fixture-1.part`)

    await expect(service.cleanupOrphans()).resolves.toEqual({ removed: 0 })
    expect(files.unlink).not.toHaveBeenCalled()

    finishWrite?.()
    await creating
  })

  it('continues orphan cleanup after unlink errors and reports a safe aggregate failure', async () => {
    const { files, service } = serviceFixture(new Uint8Array(12))
    files.directoryEntries.push(
      `${CHUNK_FILE_PREFIX}orphan-1.part`,
      `${CHUNK_FILE_PREFIX}orphan-2.part`,
    )
    files.unlink.mockRejectedValueOnce(new Error('raw orphan path'))

    const error = await service.cleanupOrphans().catch((failure: unknown) => failure)

    expect(files.unlink).toHaveBeenCalledTimes(2)
    expect(error).toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(String(error)).not.toContain('raw orphan path')
  })

  it('rejects unsafe generated IDs and source metadata before opening a file', async () => {
    const files = memoryFiles(new Uint8Array(12))
    const service = new ChunkFileService({
      files,
      userDataPath: USER_DATA_PATH,
      maximumActiveChunks: 2,
      createId: () => '../outside/token-secret',
    })

    await expect(service.create('wxfile://tmp/source', plan(12))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(service.create('wxfile://tmp/source\u0000secret', plan(12))).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
      },
    )
    expect(files.openRead).not.toHaveBeenCalled()
  })
})
