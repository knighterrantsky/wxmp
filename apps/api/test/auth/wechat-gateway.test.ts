import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  createNodeWechatTransport,
  WechatHttpGateway,
  type WechatHttpRequest,
  type WechatHttpTransport,
} from '../../src/auth/wechat-http-gateway.js'
import { WechatStubGateway } from '../../src/auth/wechat-stub-gateway.js'

const realWechatConfig = {
  appId: 'wx-test-app-id',
  appSecret: 'app-secret-sentinel',
  endpoint: 'https://api.weixin.qq.com/sns/jscode2session',
  connectTimeoutMs: 2_000,
  totalTimeoutMs: 5_000,
} as const

function jsonResponse(value: unknown, statusCode = 200) {
  return {
    statusCode,
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  }
}

function fakeNodeRequest() {
  let respond:
    ((response: PassThrough & { statusCode: number; headers: object }) => void) | undefined
  const request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
  })
  request.destroy.mockImplementation((error?: Error) => {
    queueMicrotask(() => request.emit('error', error ?? new Error('request destroyed')))
    return request
  })
  const implementation = vi.fn(
    (
      _url: URL,
      _options: object,
      handler: (response: PassThrough & { statusCode: number; headers: object }) => void,
    ) => {
      respond = handler
      return request
    },
  )
  return {
    implementation,
    request,
    respond(response: PassThrough & { statusCode: number; headers: object }) {
      if (respond === undefined) throw new Error('response handler was not installed')
      respond(response)
    },
  }
}

function fakeResponse(statusCode = 200) {
  return Object.assign(new PassThrough(), { statusCode, headers: {} })
}

describe('WechatStubGateway', () => {
  it('maps one development subject to a stable non-secret OpenID', async () => {
    const gateway = new WechatStubGateway()

    const first = await gateway.exchangeCode('dev:alice')
    const second = await gateway.exchangeCode('dev:alice')

    expect(second).toEqual(first)
    expect(first.openid).toMatch(/^stub_[0-9a-f]{48}$/)
    expect(first.openid).not.toContain('alice')
    expect(first).not.toHaveProperty('unionid')
    expect(first).not.toHaveProperty('session_key')
  })

  it.each(['', 'alice', 'dev:', 'dev:with/slash', `dev:${'a'.repeat(65)}`])(
    'rejects malformed development code %j',
    async (code) => {
      const gateway = new WechatStubGateway()

      await expect(gateway.exchangeCode(code)).rejects.toMatchObject({
        code: 'WECHAT_CODE_INVALID',
        statusCode: 401,
        retryable: false,
      })
    },
  )
})

describe('WechatHttpGateway', () => {
  it('calls the fixed code2Session endpoint and returns only public identity fields', async () => {
    let capturedRequest: WechatHttpRequest | undefined
    const transport: WechatHttpTransport = vi.fn((request: WechatHttpRequest) => {
      capturedRequest = request
      return Promise.resolve(
        jsonResponse({
          openid: 'wechat-openid-value',
          unionid: 'wechat-unionid-value',
          session_key: 'must-never-leave-the-gateway',
          errcode: 0,
        }),
      )
    })
    const signal = new AbortController().signal
    const gateway = new WechatHttpGateway(realWechatConfig, { transport })

    const identity = await gateway.exchangeCode('login-code-value', { signal })

    expect(identity).toEqual({
      openid: 'wechat-openid-value',
      unionid: 'wechat-unionid-value',
    })
    expect(identity).not.toHaveProperty('session_key')
    expect(capturedRequest).toMatchObject({
      method: 'GET',
      connectTimeoutMs: 2_000,
      totalTimeoutMs: 5_000,
      signal,
    })
    expect(capturedRequest?.url.origin).toBe('https://api.weixin.qq.com')
    expect(capturedRequest?.url.pathname).toBe('/sns/jscode2session')
    expect(Object.fromEntries(capturedRequest?.url.searchParams ?? [])).toEqual({
      appid: 'wx-test-app-id',
      secret: 'app-secret-sentinel',
      js_code: 'login-code-value',
      grant_type: 'authorization_code',
    })
  })

  it.each(['', 'x'.repeat(129)])(
    'rejects an invalid login code before the HTTP call',
    async (code) => {
      const transport = vi.fn<WechatHttpTransport>()
      const gateway = new WechatHttpGateway(realWechatConfig, { transport })

      await expect(gateway.exchangeCode(code)).rejects.toMatchObject({
        code: 'WECHAT_CODE_INVALID',
        statusCode: 401,
        retryable: false,
      })
      expect(transport).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['endpoint host', { endpoint: 'https://api.weixin.qq.com.evil.invalid/sns/jscode2session' }],
    ['endpoint query', { endpoint: 'https://api.weixin.qq.com/sns/jscode2session?extra=1' }],
    ['connect timeout', { connectTimeoutMs: 1_999 }],
    ['total timeout', { totalTimeoutMs: 4_999 }],
    ['AppID', { appId: '' }],
    ['AppSecret', { appSecret: '' }],
  ])('rejects invalid fixed %s configuration', (_description, override) => {
    expect(
      () =>
        new WechatHttpGateway(
          { ...realWechatConfig, ...override },
          { transport: () => Promise.resolve(jsonResponse({ openid: 'unused' })) },
        ),
    ).toThrow(/Invalid WeChat gateway configuration/)
  })

  it.each([40029, 40163, 40226])(
    'maps invalid, used, or blocked code error %i to WECHAT_CODE_INVALID',
    async (errcode) => {
      const transport: WechatHttpTransport = () =>
        Promise.resolve(
          jsonResponse({
            errcode,
            errmsg: 'upstream-error-body-sentinel',
            session_key: 'upstream-session-key-sentinel',
          }),
        )
      const gateway = new WechatHttpGateway(realWechatConfig, { transport })

      const error: unknown = await gateway
        .exchangeCode('invalid-code')
        .catch((reason: unknown) => reason)

      expect(error).toMatchObject({
        code: 'WECHAT_CODE_INVALID',
        statusCode: 401,
        retryable: false,
      })
      expect(String(error)).not.toMatch(
        /upstream-error-body-sentinel|upstream-session-key-sentinel/i,
      )
    },
  )

  it.each([-1, 40013, 45011])(
    'maps upstream service error %i to a retryable service error',
    async (errcode) => {
      const gateway = new WechatHttpGateway(realWechatConfig, {
        transport: () =>
          Promise.resolve(jsonResponse({ errcode, errmsg: 'private-upstream-error-body' })),
      })

      const error: unknown = await gateway
        .exchangeCode('login-code')
        .catch((reason: unknown) => reason)

      expect(error).toMatchObject({
        code: 'WECHAT_SERVICE_UNAVAILABLE',
        statusCode: 503,
        retryable: true,
      })
      expect(String(error)).not.toContain('private-upstream-error-body')
    },
  )

  it('maps non-success HTTP status without parsing or exposing the body', async () => {
    const gateway = new WechatHttpGateway(realWechatConfig, {
      transport: () =>
        Promise.resolve(
          jsonResponse(
            {
              openid: 'must-not-be-accepted',
              secret: 'private-five-hundred-body',
            },
            500,
          ),
        ),
    })

    const error: unknown = await gateway
      .exchangeCode('login-code')
      .catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      code: 'WECHAT_SERVICE_UNAVAILABLE',
      statusCode: 503,
      retryable: true,
    })
    expect(String(error)).not.toContain('private-five-hundred-body')
  })

  it('maps a network failure without exposing its message', async () => {
    const gateway = new WechatHttpGateway(realWechatConfig, {
      transport: () => Promise.reject(new Error('network failed with app-secret-sentinel')),
    })

    const error: unknown = await gateway
      .exchangeCode('login-code')
      .catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      code: 'WECHAT_SERVICE_UNAVAILABLE',
      statusCode: 503,
      retryable: true,
    })
    expect(String(error)).not.toContain('app-secret-sentinel')
  })

  it.each(['AbortError', 'TimeoutError'])(
    'maps %s transport failure to UPSTREAM_TIMEOUT',
    async (name) => {
      const timeout = new Error('timeout with private upstream data')
      timeout.name = name
      const gateway = new WechatHttpGateway(realWechatConfig, {
        transport: () => Promise.reject(timeout),
      })

      const error: unknown = await gateway
        .exchangeCode('login-code')
        .catch((reason: unknown) => reason)

      expect(error).toMatchObject({
        code: 'UPSTREAM_TIMEOUT',
        statusCode: 504,
        retryable: true,
      })
      expect(String(error)).not.toContain('private upstream data')
    },
  )

  it.each([
    ['invalid JSON', Buffer.from('{not-json', 'utf8')],
    ['null', Buffer.from('null', 'utf8')],
    ['array', Buffer.from('[]', 'utf8')],
    ['missing openid', Buffer.from('{}', 'utf8')],
    ['empty openid', Buffer.from('{"openid":""}', 'utf8')],
    ['whitespace openid', Buffer.from('{"openid":"   "}', 'utf8')],
    ['NUL openid', Buffer.from(JSON.stringify({ openid: '\u0000private' }), 'utf8')],
    ['non-string openid', Buffer.from('{"openid":1}', 'utf8')],
    ['empty unionid', Buffer.from('{"openid":"valid","unionid":""}', 'utf8')],
    [
      'control-character unionid',
      Buffer.from(JSON.stringify({ openid: 'valid', unionid: 'private\nvalue' }), 'utf8'),
    ],
    ['non-string unionid', Buffer.from('{"openid":"valid","unionid":1}', 'utf8')],
    ['non-numeric errcode', Buffer.from('{"openid":"valid","errcode":"0"}', 'utf8')],
    [
      'invalid UTF-8',
      Buffer.concat([
        Buffer.from('{"openid":"', 'utf8'),
        Buffer.from([0xff]),
        Buffer.from('"}', 'utf8'),
      ]),
    ],
    ['oversized response', Buffer.alloc(16 * 1_024 + 1, 0x20)],
  ])('maps a malformed %s response to a safe service error', async (_description, body) => {
    const gateway = new WechatHttpGateway(realWechatConfig, {
      transport: () => Promise.resolve({ statusCode: 200, body }),
    })

    const error: unknown = await gateway
      .exchangeCode('login-code')
      .catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      code: 'WECHAT_SERVICE_UNAVAILABLE',
      statusCode: 503,
      retryable: true,
    })
    expect(String(error)).not.toContain(body.toString('utf8').slice(0, 32))
  })
})

describe('Node WeChat HTTP transport', () => {
  const request = {
    url: new URL('https://api.weixin.qq.com/sns/jscode2session?secret=private'),
    method: 'GET' as const,
    connectTimeoutMs: 2_000,
    totalTimeoutMs: 5_000,
  }

  it('performs a GET and returns a bounded response body', async () => {
    const fake = fakeNodeRequest()
    const transport = createNodeWechatTransport(fake.implementation as never)
    const result = transport(request)
    fake.request.emit('socket', Object.assign(new EventEmitter(), { connecting: false }))
    const response = fakeResponse()
    fake.respond(response)
    response.end('{"openid":"value"}')

    await expect(result).resolves.toEqual({
      statusCode: 200,
      body: Buffer.from('{"openid":"value"}', 'utf8'),
    })
    expect(fake.implementation).toHaveBeenCalledWith(
      request.url,
      expect.objectContaining({ method: 'GET' }),
      expect.any(Function),
    )
    expect(fake.request.end).toHaveBeenCalledOnce()
  })

  it('enforces the two-second connection deadline', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeNodeRequest()
      const transport = createNodeWechatTransport(fake.implementation as never)
      const result = transport(request)
      const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' })

      await vi.advanceTimersByTimeAsync(1_999)
      expect(fake.request.destroy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces the five-second total deadline after connection', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeNodeRequest()
      const transport = createNodeWechatTransport(fake.implementation as never)
      const result = transport(request)
      const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' })
      fake.request.emit('socket', Object.assign(new EventEmitter(), { connecting: false }))

      await vi.advanceTimersByTimeAsync(4_999)
      expect(fake.request.destroy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops streaming a response after the size cap', async () => {
    const fake = fakeNodeRequest()
    const transport = createNodeWechatTransport(fake.implementation as never)
    const result = transport(request)
    fake.request.emit('socket', Object.assign(new EventEmitter(), { connecting: false }))
    const response = fakeResponse()
    fake.respond(response)
    response.end(Buffer.alloc(16 * 1_024 + 1, 0x61))

    await expect(result).rejects.toThrow(/response exceeded limit/i)
  })
})
