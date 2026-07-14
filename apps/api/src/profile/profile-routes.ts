import {
  NicknameRequestSchema,
  NicknameResponseSchema,
  ProfileResponseSchema,
  type NicknameRequest,
} from '@wx-upload/contracts'
import type { FastifyInstance } from 'fastify'

import {
  authenticatedRequestIdentity,
  createAccessTokenPreHandler,
  requestAuthContext,
  type AccessTokenVerifier,
} from '../auth/auth-routes.js'
import type { AuthService } from '../auth/auth-service.js'
import { sendData } from '../http/envelope.js'
import { rateLimitPolicy } from '../http/security.js'

export type ProfileRouteService = Pick<AuthService, 'getProfile' | 'updateNickname'>

export function registerProfileRoutes(
  app: FastifyInstance,
  deps: { auth: ProfileRouteService; tokens: AccessTokenVerifier },
): void {
  const authenticate = createAccessTokenPreHandler(deps.tokens)

  app.get(
    '/v1/profile',
    {
      config: { rateLimit: rateLimitPolicy('ordinary') },
      preHandler: authenticate,
      schema: { response: { 200: ProfileResponseSchema } },
    },
    async (request, reply) => {
      const { userId } = authenticatedRequestIdentity(request)
      const user = await deps.auth.getProfile(userId)
      return sendData(reply, { user })
    },
  )

  app.put<{ Body: NicknameRequest }>(
    '/v1/profile/nickname',
    {
      config: { rateLimit: rateLimitPolicy('ordinary') },
      preHandler: authenticate,
      schema: {
        body: NicknameRequestSchema,
        response: { 200: NicknameResponseSchema },
      },
    },
    async (request, reply) => {
      const identity = authenticatedRequestIdentity(request)
      const user = await deps.auth.updateNickname({
        ...identity,
        request: request.body,
        context: requestAuthContext(request),
      })
      return sendData(reply, { user })
    },
  )
}
