import type { Pagination } from '@wx-upload/contracts'
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

export function sendListData(
  reply: FastifyReply,
  data: unknown,
  pagination: Pagination,
): FastifyReply {
  return reply.send({
    data,
    meta: {
      requestId: reply.request.id,
      serverTime: requestClock(reply.request).now().toISOString(),
      pagination,
    },
  })
}
