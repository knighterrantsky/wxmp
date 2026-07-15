export type FileDescriptor = string

export interface WechatFileRuntime {
  openRead(filePath: string): Promise<FileDescriptor>
  read(fd: FileDescriptor, position: number, length: number): Promise<Uint8Array>
  close(fd: FileDescriptor): Promise<void>
  writeFile(filePath: string, data: Uint8Array): Promise<void>
  unlink(filePath: string): Promise<void>
  listDirectory(dirPath: string): Promise<string[]>
}

interface FailureCallback {
  fail(reason: unknown): void
}

export interface WxFileSystemManagerSource {
  open(
    options: FailureCallback & {
      filePath: string
      flag: 'r'
      success(result: { fd: FileDescriptor }): void
    },
  ): void
  read(
    options: FailureCallback & {
      fd: FileDescriptor
      arrayBuffer: ArrayBuffer
      offset: 0
      length: number
      position: number
      success(result: { bytesRead: number; arrayBuffer: ArrayBuffer }): void
    },
  ): void
  close(options: FailureCallback & { fd: FileDescriptor; success(): void }): void
  writeFile(
    options: FailureCallback & {
      filePath: string
      data: ArrayBuffer
      success(): void
    },
  ): void
  unlink(options: FailureCallback & { filePath: string; success(): void }): void
  readdir(
    options: FailureCallback & {
      dirPath: string
      success(result: { files: string[] }): void
    },
  ): void
}

export class WechatFileRuntimeError extends Error {
  constructor(operation: 'open' | 'read' | 'close' | 'write' | 'unlink' | 'readdir') {
    super(`WeChat file ${operation} failed`)
    this.name = 'WechatFileRuntimeError'
  }
}

function failure(operation: ConstructorParameters<typeof WechatFileRuntimeError>[0]) {
  return new WechatFileRuntimeError(operation)
}

export function createWechatFileRuntime(source: WxFileSystemManagerSource): WechatFileRuntime {
  return {
    openRead(filePath) {
      return new Promise((resolve, reject) => {
        try {
          source.open({
            filePath,
            flag: 'r',
            success(result) {
              if (typeof result.fd !== 'string' || result.fd.length === 0) {
                reject(failure('open'))
                return
              }
              resolve(result.fd)
            },
            fail() {
              reject(failure('open'))
            },
          })
        } catch {
          reject(failure('open'))
        }
      })
    },

    read(fd, position, length) {
      return new Promise((resolve, reject) => {
        if (
          !Number.isSafeInteger(position) ||
          position < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1
        ) {
          reject(failure('read'))
          return
        }
        const arrayBuffer = new ArrayBuffer(length)
        try {
          source.read({
            fd,
            arrayBuffer,
            offset: 0,
            length,
            position,
            success(result) {
              if (
                !Number.isSafeInteger(result.bytesRead) ||
                result.bytesRead < 0 ||
                result.bytesRead > length ||
                !(result.arrayBuffer instanceof ArrayBuffer) ||
                result.arrayBuffer.byteLength < result.bytesRead
              ) {
                reject(failure('read'))
                return
              }
              resolve(new Uint8Array(result.arrayBuffer, 0, result.bytesRead).slice())
            },
            fail() {
              reject(failure('read'))
            },
          })
        } catch {
          reject(failure('read'))
        }
      })
    },

    close(fd) {
      return new Promise((resolve, reject) => {
        try {
          source.close({
            fd,
            success: resolve,
            fail() {
              reject(failure('close'))
            },
          })
        } catch {
          reject(failure('close'))
        }
      })
    },

    writeFile(filePath, data) {
      return new Promise((resolve, reject) => {
        try {
          source.writeFile({
            filePath,
            data: data.slice().buffer,
            success: resolve,
            fail() {
              reject(failure('write'))
            },
          })
        } catch {
          reject(failure('write'))
        }
      })
    },

    unlink(filePath) {
      return new Promise((resolve, reject) => {
        try {
          source.unlink({
            filePath,
            success: resolve,
            fail() {
              reject(failure('unlink'))
            },
          })
        } catch {
          reject(failure('unlink'))
        }
      })
    },

    listDirectory(dirPath) {
      return new Promise((resolve, reject) => {
        try {
          source.readdir({
            dirPath,
            success(result) {
              if (
                !Array.isArray(result.files) ||
                result.files.some((file) => typeof file !== 'string')
              ) {
                reject(failure('readdir'))
                return
              }
              resolve([...result.files])
            },
            fail() {
              reject(failure('readdir'))
            },
          })
        } catch {
          reject(failure('readdir'))
        }
      })
    },
  }
}
