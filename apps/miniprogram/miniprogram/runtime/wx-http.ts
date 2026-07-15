import type { HttpRequest, HttpResponse } from './wechat-runtime.js'

export interface WxRequestSource {
  request(options: {
    url: string
    method: HttpRequest['method']
    header?: Record<string, string>
    data?: unknown
    success(result: {
      statusCode: number
      data: unknown
      header: Record<string, string | readonly string[]>
    }): void
    fail(reason: unknown): void
  }): unknown
}

function normalizeHeaders(
  headers: Record<string, string | readonly string[]>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.toString()]),
  )
}

export class WechatRequestNetworkError extends Error {
  readonly networkError = true

  constructor() {
    super('WeChat request failed')
    this.name = 'WechatRequestNetworkError'
  }
}

export function requestWithWechatRuntime<T>(
  source: WxRequestSource,
  request: HttpRequest,
  decode?: (value: unknown) => T,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    try {
      source.request({
        method: request.method,
        url: request.url,
        ...(request.headers === undefined ? {} : { header: request.headers }),
        ...(request.data === undefined ? {} : { data: request.data }),
        success(result) {
          try {
            resolve({
              statusCode: result.statusCode,
              data: decode === undefined ? (result.data as T) : decode(result.data),
              headers: normalizeHeaders(result.header),
            })
          } catch (error) {
            reject(error instanceof Error ? error : new Error('WeChat response decoding failed'))
          }
        },
        fail() {
          reject(new WechatRequestNetworkError())
        },
      })
    } catch {
      reject(new WechatRequestNetworkError())
    }
  })
}
