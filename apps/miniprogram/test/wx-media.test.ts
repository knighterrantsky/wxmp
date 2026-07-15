import { describe, expect, it, vi } from 'vitest'

import {
  chooseMediaWithWechatRuntime,
  WechatMediaSelectionError,
  type WxChooseMediaOptions,
  type WxChooseMediaSource,
} from '../miniprogram/runtime/wx-media.js'

function imageFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tempFilePath: 'wxfile://tmp/photo.jpg',
    size: 12,
    fileType: 'image',
    duration: 0,
    height: 1080,
    width: 1920,
    thumbTempFilePath: '',
    ...overrides,
  }
}

function successfulResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tempFiles: [imageFile()],
    type: 'image',
    errMsg: 'chooseMedia:ok',
    ...overrides,
  }
}

function sourceReturning(result: unknown): WxChooseMediaSource {
  return {
    chooseMedia(options) {
      options.success(result)
    },
  }
}

async function expectSelectionError(
  promise: Promise<unknown>,
  code: WechatMediaSelectionError['code'],
): Promise<void> {
  try {
    await promise
    throw new Error('expected media selection to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(WechatMediaSelectionError)
    expect(error).toMatchObject({ code })
  }
}

describe('WeChat chooseMedia runtime adapter', () => {
  it('uses the fixed nine-item image/video request and returns a detached normalized selection', async () => {
    let request: WxChooseMediaOptions | undefined
    const raw = successfulResult({
      tempFiles: [
        imageFile({ extraPrivateField: 'must-not-escape' }),
        imageFile({
          tempFilePath: 'wxfile://tmp/movie.mp4',
          size: 209_715_200,
          fileType: 'video',
          duration: 12,
          thumbTempFilePath: 'wxfile://tmp/movie-cover.jpg',
        }),
      ],
      type: 'mix',
      extraPrivateField: 'must-not-escape',
    })
    const source: WxChooseMediaSource = {
      chooseMedia(options) {
        request = options
        options.success(raw)
      },
    }

    const selected = await chooseMediaWithWechatRuntime(source)

    expect(request).toMatchObject({ count: 9, mediaType: ['image', 'video'] })
    expect(Object.keys(request ?? {}).sort()).toEqual(['count', 'fail', 'mediaType', 'success'])
    expect(selected).toEqual([
      {
        sourcePath: 'wxfile://tmp/photo.jpg',
        sizeBytes: 12,
        kind: 'image',
      },
      {
        sourcePath: 'wxfile://tmp/movie.mp4',
        sizeBytes: 209_715_200,
        kind: 'video',
      },
    ])

    const rawFiles = raw['tempFiles'] as Record<string, unknown>[]
    rawFiles[0] = imageFile({ tempFilePath: 'wxfile://tmp/replaced.jpg' })
    expect(selected[0]?.sourcePath).toBe('wxfile://tmp/photo.jpg')
  })

  it.each([
    ['non-object result', null],
    ['missing success marker', successfulResult({ errMsg: 'chooseMedia:fail secret' })],
    ['unknown aggregate type', successfulResult({ type: 'document' })],
    ['missing files', successfulResult({ tempFiles: undefined })],
    ['empty files', successfulResult({ tempFiles: [] })],
    [
      'more than nine files',
      successfulResult({
        tempFiles: Array.from({ length: 10 }, (_, index) =>
          imageFile({ tempFilePath: `wxfile://tmp/${String(index)}.jpg` }),
        ),
      }),
    ],
    ['non-object file', successfulResult({ tempFiles: [null] })],
    ['empty path', successfulResult({ tempFiles: [imageFile({ tempFilePath: '   ' })] })],
    [
      'path containing a NUL byte',
      successfulResult({ tempFiles: [imageFile({ tempFilePath: 'wxfile://tmp/a\u0000.jpg' })] }),
    ],
    [
      'unreasonably long path',
      successfulResult({
        tempFiles: [imageFile({ tempFilePath: `wxfile://${'a'.repeat(4090)}` })],
      }),
    ],
    ['negative size', successfulResult({ tempFiles: [imageFile({ size: -1 })] })],
    ['fractional size', successfulResult({ tempFiles: [imageFile({ size: 12.5 })] })],
    ['non-finite size', successfulResult({ tempFiles: [imageFile({ size: Number.NaN })] })],
    ['unknown file type', successfulResult({ tempFiles: [imageFile({ fileType: 'audio' })] })],
    [
      'aggregate type contradicting a file type',
      successfulResult({ type: 'image', tempFiles: [imageFile({ fileType: 'video' })] }),
    ],
  ])('rejects an invalid %s with one sanitized protocol error', async (_label, result) => {
    const promise = chooseMediaWithWechatRuntime(sourceReturning(result))

    await expectSelectionError(promise, 'INVALID_RESPONSE')
    await expect(promise).rejects.toThrow('WeChat media selection response was invalid')
    await expect(promise).rejects.not.toThrow(/secret|wxfile/u)
  })

  it('exposes user cancellation as a stable error code without exposing the runtime reason', async () => {
    const source: WxChooseMediaSource = {
      chooseMedia(options) {
        options.fail({
          errMsg: 'chooseMedia:fail cancel',
          privateRuntimeDetail: 'album-secret',
        })
      },
    }

    const promise = chooseMediaWithWechatRuntime(source)

    await expectSelectionError(promise, 'CANCELLED')
    await expect(promise).rejects.toThrow('WeChat media selection was cancelled')
    await expect(promise).rejects.not.toThrow(/album-secret|chooseMedia/u)
  })

  it('sanitizes ordinary callback failures', async () => {
    const source: WxChooseMediaSource = {
      chooseMedia(options) {
        options.fail({ errMsg: 'chooseMedia:fail /private/path runtime-secret' })
      },
    }

    const promise = chooseMediaWithWechatRuntime(source)

    await expectSelectionError(promise, 'FAILED')
    await expect(promise).rejects.toThrow('WeChat media selection failed')
    await expect(promise).rejects.not.toThrow(/private|runtime-secret/u)
  })

  it('turns a synchronous runtime exception into the same sanitized failure', async () => {
    const source: WxChooseMediaSource = {
      chooseMedia: vi.fn(() => {
        throw new Error('native bridge secret')
      }),
    }

    const promise = chooseMediaWithWechatRuntime(source)

    await expectSelectionError(promise, 'FAILED')
    await expect(promise).rejects.not.toThrow(/native bridge secret/u)
  })
})
