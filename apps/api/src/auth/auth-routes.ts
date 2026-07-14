import {
  LogoutRequestSchema,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
  WechatLoginRequestSchema,
  WechatLoginResponseSchema,
  type RefreshTokenRequest,
  type WechatLoginRequest,
} from '@wx-upload/contracts'
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'

import { sendData } from '../http/envelope.js'
import { ApiError } from '../http/errors.js'
import {
  authenticatedSessionId,
  authenticatedUserId,
  setAuthenticatedUser,
} from '../http/request-context.js'
import { rateLimitPolicy } from '../http/security.js'
import type { AuthService } from './auth-service.js'
import type { TokenService } from './token-service.js'

export type AuthRouteService = Pick<AuthService, 'loginWithWechat' | 'refresh' | 'logout'>
export type AccessTokenVerifier = Pick<TokenService, 'verifyAccessToken'>

const ACCESS_TOKEN_PATTERN = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/u

function unauthorized(): never {
  throw new ApiError({
    code: 'UNAUTHORIZED',
    message: '请先登录',
    statusCode: 401,
  })
}

export function requestAuthContext(request: FastifyRequest): {
  requestId: string
  sourceIp: string
  userAgent?: string
} {
  const userAgent = request.headers['user-agent']
  return {
    requestId: request.id,
    sourceIp: request.ip,
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  }
}

export function authenticatedRequestIdentity(request: FastifyRequest): {
  userId: string
  sessionId: string
} {
  const userId = authenticatedUserId(request)
  const sessionId = authenticatedSessionId(request)
  if (userId === undefined || sessionId === undefined) unauthorized()
  return { userId, sessionId }
}

export function createAccessTokenPreHandler(
  tokens: AccessTokenVerifier,
): preHandlerAsyncHookHandler {
  return async (request) => {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string') unauthorized()
    const match = ACCESS_TOKEN_PATTERN.exec(authorization)
    const token = match?.[1]
    if (token === undefined) unauthorized()

    const claims = await tokens.verifyAccessToken(token)
    setAuthenticatedUser(request, claims.sub, claims.sid)
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { auth: AuthRouteService; tokens: AccessTokenVerifier },
): void {
  const authenticate = createAccessTokenPreHandler(deps.tokens)

  app.post<{ Body: WechatLoginRequest }>(
    '/v1/auth/wechat-login',
    {
      config: { rateLimit: rateLimitPolicy('login') },
      schema: {
        body: WechatLoginRequestSchema,
        response: { 200: WechatLoginResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await deps.auth.loginWithWechat(
        request.body.code,
        request.body.deviceId,
        requestAuthContext(request),
      )
      return sendData(reply, result)
    },
  )

  app.post<{ Body: RefreshTokenRequest }>(
    '/v1/auth/refresh',
    {
      config: { rateLimit: rateLimitPolicy('refresh') },
      schema: {
        body: RefreshTokenRequestSchema,
        response: { 200: RefreshTokenResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await deps.auth.refresh(request.body.refreshToken, requestAuthContext(request))
      return sendData(reply, result)
    },
  )

  app.post<{ Body: RefreshTokenRequest }>(
    '/v1/auth/logout',
    {
      config: { rateLimit: rateLimitPolicy('ordinary') },
      preHandler: authenticate,
      schema: { body: LogoutRequestSchema },
    },
    async (request, reply) => {
      const identity = authenticatedRequestIdentity(request)
      await deps.auth.logout({
        ...identity,
        refreshToken: request.body.refreshToken,
        context: requestAuthContext(request),
      })
      return reply.code(204).send()
    },
  )
}
