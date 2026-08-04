import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify'

import { ApiError } from '../http/errors.js'
import { rateLimitPolicy } from '../http/security.js'
import { ADMIN_SESSION_TTL_SECONDS, type AdminAuthService } from './admin-auth.js'
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JAVASCRIPT } from './admin-page.js'
import type { AdminUploadCategory, AdminUploadRepository } from './admin-repository.js'

const COOKIE_NAME = '__Host-wx_admin_session'
const ADMIN_CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'"
const CATEGORIES = [
  'server_receiving',
  'r2_retrying',
  'r2_ready',
  'user_reupload',
  'operator_review',
  'cancelled',
] as const satisfies readonly AdminUploadCategory[]

interface AdminLoginBody {
  username: string
  password: string
}

interface AdminUploadQuery {
  category?: AdminUploadCategory
  q?: string
  limit?: number
  offset?: number
}

function unauthorized(): never {
  throw new ApiError({
    code: 'UNAUTHORIZED',
    message: '请先登录',
    statusCode: 401,
  })
}

function cookieValue(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie
  if (header === undefined || header.length > 4_096) return undefined
  const matches = header
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${COOKIE_NAME}=`))
  if (matches.length !== 1) return undefined
  return matches[0]?.slice(COOKIE_NAME.length + 1)
}

function setAdminHeaders(reply: FastifyReply): void {
  reply.headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': ADMIN_CSP,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  })
}

function normalizedQuery(value: string | undefined): string | null {
  const normalized = value?.normalize('NFC').trim()
  return normalized === undefined || normalized === '' ? null : normalized
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { auth: AdminAuthService; repository: AdminUploadRepository },
): void {
  const adminHeaders: onRequestAsyncHookHandler = (_request, reply) => {
    setAdminHeaders(reply)
    return Promise.resolve()
  }
  const authenticate: preHandlerAsyncHookHandler = (request) => {
    if (!deps.auth.verifySessionToken(cookieValue(request))) unauthorized()
    return Promise.resolve()
  }
  const protectedRoute = {
    onRequest: adminHeaders,
    preHandler: authenticate,
    config: { rateLimit: rateLimitPolicy('adminRead') },
  }

  app.get('/admin', { onRequest: adminHeaders }, (_request, reply) => reply.redirect('/admin/'))
  app.get('/admin/', { onRequest: adminHeaders }, (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(ADMIN_HTML),
  )
  app.get('/admin/assets/admin.css', { onRequest: adminHeaders }, (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(ADMIN_CSS),
  )
  app.get('/admin/assets/admin.js', { onRequest: adminHeaders }, (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(ADMIN_JAVASCRIPT),
  )

  app.post<{ Body: AdminLoginBody }>(
    '/admin/api/login',
    {
      onRequest: adminHeaders,
      config: { rateLimit: rateLimitPolicy('adminLogin') },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await deps.auth.verifyCredentials(request.body.username, request.body.password))) {
        unauthorized()
      }
      reply.header(
        'Set-Cookie',
        `${COOKIE_NAME}=${deps.auth.createSessionToken()}; Path=/; Max-Age=${String(ADMIN_SESSION_TTL_SECONDS)}; HttpOnly; Secure; SameSite=Strict`,
      )
      return reply.send({ authenticated: true, username: deps.auth.username })
    },
  )

  app.post('/admin/api/logout', protectedRoute, (_request, reply) => {
    reply.header(
      'Set-Cookie',
      `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`,
    )
    return reply.code(204).send()
  })

  app.get('/admin/api/session', protectedRoute, (_request, reply) =>
    reply.send({ authenticated: true, username: deps.auth.username }),
  )

  app.get('/admin/api/summary', protectedRoute, async (_request, reply) =>
    reply.send(await deps.repository.summary()),
  )

  app.get<{ Querystring: AdminUploadQuery }>(
    '/admin/api/uploads',
    {
      ...protectedRoute,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: { type: 'string', enum: CATEGORIES },
            q: { type: 'string', minLength: 1, maxLength: 80 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
            offset: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 0 },
          },
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await deps.repository.list({
          category: request.query.category ?? null,
          query: normalizedQuery(request.query.q),
          limit: request.query.limit ?? 30,
          offset: request.query.offset ?? 0,
        }),
      ),
  )
}
