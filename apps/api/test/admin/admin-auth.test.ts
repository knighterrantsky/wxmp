import { describe, expect, it } from 'vitest'

import {
  AdminAuthService,
  createAdminPasswordVerifier,
  parseAdminPasswordVerifier,
} from '../../src/admin/admin-auth.js'

describe('admin authentication', () => {
  it('verifies scrypt credentials without storing the plaintext password', async () => {
    const password = 'a-private-test-password'
    const verifier = await createAdminPasswordVerifier(password, Buffer.alloc(16, 0x51))
    const service = new AdminAuthService({
      username: 'operator',
      passwordVerifier: verifier,
      sessionSecret: Buffer.alloc(32, 0x52),
      clock: { now: () => new Date('2026-08-04T02:00:00.000Z') },
    })

    expect(verifier).not.toContain(password)
    expect(parseAdminPasswordVerifier(verifier)).toBeDefined()
    await expect(service.verifyCredentials('operator', password)).resolves.toBe(true)
    await expect(service.verifyCredentials('operator', 'wrong-password')).resolves.toBe(false)
    await expect(service.verifyCredentials('wrong-user', password)).resolves.toBe(false)
  })

  it('rejects tampered and expired stateless sessions', async () => {
    let now = new Date('2026-08-04T02:00:00.000Z')
    const verifier = await createAdminPasswordVerifier(
      'a-private-test-password',
      Buffer.alloc(16, 0x53),
    )
    const service = new AdminAuthService({
      username: 'operator',
      passwordVerifier: verifier,
      sessionSecret: Buffer.alloc(32, 0x54),
      clock: { now: () => now },
    })
    const token = service.createSessionToken()

    expect(service.verifySessionToken(token)).toBe(true)
    expect(service.verifySessionToken(`${token.slice(0, -1)}x`)).toBe(false)
    now = new Date('2026-08-04T11:00:01.000Z')
    expect(service.verifySessionToken(token)).toBe(false)
  })

  it.each([
    'plain-text',
    'scrypt:1024:8:1:c2hvcnQ:c2hvcnQ',
    `scrypt:16384:7:1:${Buffer.alloc(16).toString('base64url')}:${Buffer.alloc(32).toString('base64url')}`,
  ])('rejects an unsafe password verifier: %s', (verifier) => {
    expect(parseAdminPasswordVerifier(verifier)).toBeUndefined()
  })
})
