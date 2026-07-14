import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'

import { ApiError } from '../http/errors.js'
import type { WechatExchangeOptions, WechatGateway, WechatIdentity } from './wechat-gateway.js'

const INVALID_CODE_ERRORS = new Set([40_029, 40_163, 40_226])
const CODE2SESSION_ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session'
const CONNECT_TIMEOUT_MS = 2_000
const TOTAL_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 16 * 1_024
const MAX_WECHAT_IDENTIFIER_LENGTH = 128
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const IDENTIFIER_CONTROL_OR_SURROGATE = /[\p{Cc}\p{Cs}]/u

export interface WechatHttpGatewayConfig {
  readonly appId: string
  readonly appSecret: string
  readonly endpoint: string
  readonly connectTimeoutMs: number
  readonly totalTimeoutMs: number
}

export interface WechatHttpRequest {
  readonly url: URL
  readonly method: 'GET'
  readonly connectTimeoutMs: number
  readonly totalTimeoutMs: number
  readonly signal?: AbortSignal
}

export interface WechatHttpResponse {
  readonly statusCode: number
  readonly body: Uint8Array
}

export type WechatHttpTransport = (request: WechatHttpRequest) => Promise<WechatHttpResponse>

export interface WechatHttpGatewayOptions {
  readonly transport?: WechatHttpTransport
}

type HttpsRequestImplementation = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest

function transportError(name: 'AbortError' | 'TimeoutError', message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export function createNodeWechatTransport(
  requestImplementation: HttpsRequestImplementation = httpsRequest,
): WechatHttpTransport {
  return (input) => {
    if (input.signal?.aborted === true) {
      return Promise.reject(transportError('AbortError', 'WeChat request was aborted'))
    }

    return new Promise<WechatHttpResponse>((resolve, reject) => {
      let settled = false
      const resources: {
        connectTimer?: ReturnType<typeof setTimeout>
        totalTimer?: ReturnType<typeof setTimeout>
        abortRequest?: () => void
      } = {}

      const cleanup = (): void => {
        if (resources.connectTimer !== undefined) clearTimeout(resources.connectTimer)
        if (resources.totalTimer !== undefined) clearTimeout(resources.totalTimer)
        if (resources.abortRequest !== undefined) {
          input.signal?.removeEventListener('abort', resources.abortRequest)
        }
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const succeed = (value: WechatHttpResponse): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }

      let clientRequest: ClientRequest
      try {
        clientRequest = requestImplementation(
          input.url,
          {
            method: input.method,
            headers: {
              accept: 'application/json',
              'user-agent': 'wx-private-media-upload/1',
            },
          },
          (incoming) => {
            if (resources.connectTimer !== undefined) clearTimeout(resources.connectTimer)
            const chunks: Buffer[] = []
            let receivedBytes = 0
            incoming.on('data', (chunk: unknown) => {
              if (settled) return
              const bytes = Buffer.isBuffer(chunk)
                ? chunk
                : typeof chunk === 'string'
                  ? Buffer.from(chunk, 'utf8')
                  : Buffer.from(chunk as Uint8Array)
              receivedBytes += bytes.byteLength
              if (receivedBytes > MAX_RESPONSE_BYTES) {
                const error = new Error('WeChat response exceeded limit')
                fail(error)
                incoming.destroy()
                clientRequest.destroy(error)
                return
              }
              chunks.push(bytes)
            })
            incoming.once('end', () => {
              succeed({
                statusCode: incoming.statusCode ?? 0,
                body: Buffer.concat(chunks, receivedBytes),
              })
            })
            incoming.once('aborted', () => {
              fail(new Error('WeChat response aborted'))
            })
            incoming.once('error', (error) => {
              fail(error)
            })
          },
        )
      } catch {
        fail(new Error('WeChat request could not start'))
        return
      }

      clientRequest.once('socket', (socket) => {
        if (!socket.connecting) {
          if (resources.connectTimer !== undefined) clearTimeout(resources.connectTimer)
          return
        }
        socket.once('secureConnect', () => {
          if (resources.connectTimer !== undefined) clearTimeout(resources.connectTimer)
        })
      })
      clientRequest.once('error', (error) => {
        fail(error)
      })

      resources.connectTimer = setTimeout(() => {
        clientRequest.destroy(transportError('TimeoutError', 'WeChat connection timed out'))
      }, input.connectTimeoutMs)
      resources.totalTimer = setTimeout(() => {
        clientRequest.destroy(transportError('TimeoutError', 'WeChat request timed out'))
      }, input.totalTimeoutMs)
      resources.abortRequest = () => {
        clientRequest.destroy(transportError('AbortError', 'WeChat request was aborted'))
      }
      input.signal?.addEventListener('abort', resources.abortRequest, { once: true })
      if (input.signal?.aborted === true) resources.abortRequest()
      clientRequest.end()
    })
  }
}

function upstreamErrorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(Reflect.get(error, 'name'))
    : undefined
}

function serviceUnavailable(): ApiError {
  return new ApiError({
    code: 'WECHAT_SERVICE_UNAVAILABLE',
    message: '微信服务暂时不可用',
    statusCode: 503,
    retryable: true,
  })
}

function upstreamTimeout(): ApiError {
  return new ApiError({
    code: 'UPSTREAM_TIMEOUT',
    message: '上游服务请求超时',
    statusCode: 504,
    retryable: true,
  })
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_WECHAT_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !IDENTIFIER_CONTROL_OR_SURROGATE.test(value)
  )
}

function parseIdentity(body: Uint8Array): WechatIdentity {
  if (body.byteLength > MAX_RESPONSE_BYTES) throw serviceUnavailable()

  let payload: unknown
  try {
    payload = JSON.parse(UTF8_DECODER.decode(body))
  } catch {
    throw serviceUnavailable()
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw serviceUnavailable()
  }

  const errcode: unknown = Reflect.get(payload, 'errcode')
  if (errcode !== undefined && !Number.isInteger(errcode)) throw serviceUnavailable()
  if (typeof errcode === 'number' && INVALID_CODE_ERRORS.has(errcode)) {
    throw new ApiError({
      code: 'WECHAT_CODE_INVALID',
      message: '微信登录凭据无效或已使用',
      statusCode: 401,
    })
  }
  if (typeof errcode === 'number' && errcode !== 0) throw serviceUnavailable()

  const openid: unknown = Reflect.get(payload, 'openid')
  const unionid: unknown = Reflect.get(payload, 'unionid')
  if (!validIdentifier(openid)) throw serviceUnavailable()
  if (unionid !== undefined && !validIdentifier(unionid)) throw serviceUnavailable()
  return {
    openid,
    ...(unionid === undefined ? {} : { unionid }),
  }
}

export class WechatHttpGateway implements WechatGateway {
  readonly #config: WechatHttpGatewayConfig
  readonly #transport: WechatHttpTransport

  constructor(config: WechatHttpGatewayConfig, options: WechatHttpGatewayOptions = {}) {
    if (
      config.endpoint !== CODE2SESSION_ENDPOINT ||
      config.connectTimeoutMs !== CONNECT_TIMEOUT_MS ||
      config.totalTimeoutMs !== TOTAL_TIMEOUT_MS ||
      config.appId.length === 0 ||
      config.appSecret.length === 0
    ) {
      throw new Error('Invalid WeChat gateway configuration')
    }
    this.#config = { ...config }
    this.#transport = options.transport ?? createNodeWechatTransport()
  }

  async exchangeCode(code: string, options: WechatExchangeOptions = {}): Promise<WechatIdentity> {
    if (code.length < 1 || code.length > 128) {
      throw new ApiError({
        code: 'WECHAT_CODE_INVALID',
        message: '微信登录凭据无效或已使用',
        statusCode: 401,
      })
    }
    const url = new URL(this.#config.endpoint)
    url.search = new URLSearchParams({
      appid: this.#config.appId,
      secret: this.#config.appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString()
    let response: WechatHttpResponse
    try {
      response = await this.#transport({
        url,
        method: 'GET',
        connectTimeoutMs: this.#config.connectTimeoutMs,
        totalTimeoutMs: this.#config.totalTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      const name = upstreamErrorName(error)
      if (name === 'AbortError' || name === 'TimeoutError') throw upstreamTimeout()
      throw serviceUnavailable()
    }
    if (response.statusCode !== 200) throw serviceUnavailable()
    return parseIdentity(response.body)
  }
}
