import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createAdminPasswordVerifier } from '../../src/admin/admin-auth.js'
import type { AdminUploadRepository } from '../../src/admin/admin-repository.js'
import { buildApp } from '../../src/app.js'
import { fakeDependencies } from '../support/fakes.js'

const apps: ReturnType<typeof buildApp>[] = []
let passwordVerifier = ''

beforeAll(async () => {
  passwordVerifier = await createAdminPasswordVerifier(
    'a-private-test-password',
    Buffer.alloc(16, 0x61),
  )
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function repository(): {
  value: AdminUploadRepository
  summary: ReturnType<typeof vi.fn<AdminUploadRepository['summary']>>
  list: ReturnType<typeof vi.fn<AdminUploadRepository['list']>>
} {
  const summary = vi.fn<AdminUploadRepository['summary']>().mockResolvedValue({
    users: 2,
    total: 6,
    serverReceiving: 1,
    r2Retrying: 1,
    r2Ready: 1,
    userReupload: 1,
    operatorReview: 1,
    cancelled: 1,
  })
  const list = vi.fn<AdminUploadRepository['list']>().mockResolvedValue({ total: 0, rows: [] })
  return { value: { summary, list }, summary, list }
}

function testApp(adminRepository = repository().value) {
  const app = buildApp(
    fakeDependencies({
      admin: {
        username: 'operator',
        passwordVerifier,
        sessionSecret: Buffer.alloc(32, 0x62),
      },
      adminRepository,
    }),
  )
  apps.push(app)
  return app
}

async function login(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/admin/api/login',
    payload: { username: 'operator', password: 'a-private-test-password' },
  })
  expect(response.statusCode).toBe(200)
  const setCookie = response.headers['set-cookie']
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('Secure')
  expect(setCookie).toContain('SameSite=Strict')
  return String(setCookie).split(';')[0] ?? ''
}

describe('admin routes', () => {
  it('serves a no-store, framed-denied page with external assets only', async () => {
    const app = testApp()

    const page = await app.inject({ method: 'GET', url: '/admin/' })
    const script = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' })

    expect(page.statusCode).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.headers['content-security-policy']).toContain("script-src 'self'")
    expect(page.body).toContain('素材上传后台')
    expect(page.body).not.toMatch(/<script>[^<]/u)
    expect(script.body).not.toContain('innerHTML')
  })

  it('requires a valid login and signed cookie for private data', async () => {
    const adminRepository = repository()
    const app = testApp(adminRepository.value)

    const anonymous = await app.inject({ method: 'GET', url: '/admin/api/summary' })
    const invalid = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { username: 'operator', password: 'wrong-password' },
    })
    const cookie = await login(app)
    const summary = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { cookie },
    })
    const tampered = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { cookie: `${cookie}x` },
    })

    expect(anonymous.statusCode).toBe(401)
    expect(invalid.statusCode).toBe(401)
    expect(invalid.headers['set-cookie']).toBeUndefined()
    expect(summary.statusCode).toBe(200)
    expect(summary.json()).toMatchObject({ total: 6, operatorReview: 1 })
    expect(summary.headers['cache-control']).toBe('no-store')
    expect(tampered.statusCode).toBe(401)
    expect(adminRepository.summary).toHaveBeenCalledOnce()
  })

  it('validates filters and passes normalized pagination to the repository', async () => {
    const adminRepository = repository()
    const app = testApp(adminRepository.value)
    const cookie = await login(app)

    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/uploads?category=operator_review&q=%20alice%20&limit=20&offset=40',
      headers: { cookie },
    })
    const invalid = await app.inject({
      method: 'GET',
      url: '/admin/api/uploads?category=unknown',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(adminRepository.list).toHaveBeenCalledWith({
      category: 'operator_review',
      query: 'alice',
      limit: 20,
      offset: 40,
    })
    expect(invalid.statusCode).toBe(422)
  })

  it('clears the admin cookie on logout', async () => {
    const app = testApp()
    const cookie = await login(app)

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/logout',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['set-cookie']).toContain('Max-Age=0')
  })
})
