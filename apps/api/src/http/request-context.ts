import type { FastifyRequest } from 'fastify'

import type { Clock } from '../lib/clock.js'
import { systemClock } from '../lib/clock.js'

interface RequestContext {
  clock: Clock
  authenticatedUserId?: string
}

const contexts = new WeakMap<FastifyRequest, RequestContext>()

export function initializeRequestContext(request: FastifyRequest, clock: Clock): void {
  contexts.set(request, { clock })
}

export function setAuthenticatedUser(request: FastifyRequest, userId: string): void {
  const current = contexts.get(request)
  contexts.set(
    request,
    current === undefined
      ? { clock: systemClock, authenticatedUserId: userId }
      : { ...current, authenticatedUserId: userId },
  )
}

export function authenticatedUserId(request: FastifyRequest): string | undefined {
  return contexts.get(request)?.authenticatedUserId
}

export function requestClock(request: FastifyRequest): Clock {
  return contexts.get(request)?.clock ?? systemClock
}
