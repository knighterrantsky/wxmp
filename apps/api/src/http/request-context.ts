import type { FastifyRequest } from 'fastify'

import type { Clock } from '../lib/clock.js'
import { systemClock } from '../lib/clock.js'

interface RequestContext {
  clock: Clock
  authenticatedUserId?: string
  authenticatedSessionId?: string
}

const contexts = new WeakMap<FastifyRequest, RequestContext>()

export function initializeRequestContext(request: FastifyRequest, clock: Clock): void {
  contexts.set(request, { clock })
}

export function setAuthenticatedUser(
  request: FastifyRequest,
  userId: string,
  sessionId?: string,
): void {
  const current = contexts.get(request)
  contexts.set(
    request,
    current === undefined
      ? {
          clock: systemClock,
          authenticatedUserId: userId,
          ...(sessionId === undefined ? {} : { authenticatedSessionId: sessionId }),
        }
      : {
          ...current,
          authenticatedUserId: userId,
          ...(sessionId === undefined ? {} : { authenticatedSessionId: sessionId }),
        },
  )
}

export function authenticatedUserId(request: FastifyRequest): string | undefined {
  return contexts.get(request)?.authenticatedUserId
}

export function authenticatedSessionId(request: FastifyRequest): string | undefined {
  return contexts.get(request)?.authenticatedSessionId
}

export function requestClock(request: FastifyRequest): Clock {
  return contexts.get(request)?.clock ?? systemClock
}
