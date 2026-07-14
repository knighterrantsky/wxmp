import type { FastifyReply } from 'fastify'

import { requestClock } from './request-context.js'

export function sendData(reply: FastifyReply, data: unknown, statusCode = 200): FastifyReply {
  return reply.code(statusCode).send({
    data,
    meta: {
      requestId: reply.request.id,
      serverTime: requestClock(reply.request).now().toISOString(),
    },
  })
}
