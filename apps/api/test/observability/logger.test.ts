import { describe, expect, it } from 'vitest'

import { createProductionLogger } from '../../src/observability/logger.js'

describe('production logger', () => {
  it('writes NDJSON and recursively removes private fields and configured secrets', () => {
    const lines: string[] = []
    const secret = 'configured-secret-sentinel'
    const logger = createProductionLogger({
      environment: 'test',
      service: 'wx-upload-api',
      secrets: [secret],
      destination: { write: (line) => lines.push(line) },
    })

    logger.info(
      {
        requestId: '01981c31-4c80-7000-8000-000000000001',
        route: '/v1/uploads/:uploadId',
        method: 'POST',
        statusCode: 500,
        durationMs: 12,
        userId: '01981c31-4c80-7000-8000-000000000011',
        nested: {
          authorization: 'Bearer access-token-sentinel',
          Cookie: 'refreshToken=refresh-token-sentinel',
          profile: { nickname: 'nickname-sentinel', openid: 'openid-sentinel' },
          storage: [{ objectKey: 'users/private/object.jpg', ETag: 'etag-sentinel' }],
          R2_SECRET_ACCESS_KEY: 'r2-secret-sentinel',
          filename: 'private-filename-sentinel.jpg',
          originalFilename: 'original-filename-sentinel.jpg',
          r2_object_key: 'r2-object-key-sentinel',
          password: 'password-sentinel',
          databaseUrl: 'database-url-sentinel',
          jwtPrivateKey: 'jwt-private-key-sentinel',
          idToken: 'id-token-sentinel',
        },
        error: new Error(`database failed with ${secret}`, {
          cause: { session_key: 'session-key-sentinel' },
        }),
      },
      `request failed with ${secret}`,
    )
    logger.flush()

    expect(lines).toHaveLength(1)
    const output = lines[0] ?? ''
    const entry: unknown = JSON.parse(output)
    expect(entry).toMatchObject({
      service: 'wx-upload-api',
      environment: 'test',
      requestId: '01981c31-4c80-7000-8000-000000000001',
      route: '/v1/uploads/:uploadId',
      method: 'POST',
      statusCode: 500,
      durationMs: 12,
    })
    expect(entry).toHaveProperty('time')
    expect(entry).toHaveProperty('level')
    expect(output).not.toMatch(
      /access-token-sentinel|refresh-token-sentinel|nickname-sentinel|openid-sentinel|users\/private|etag-sentinel|r2-secret-sentinel|session-key-sentinel|configured-secret-sentinel|private-filename-sentinel|original-filename-sentinel|r2-object-key-sentinel|password-sentinel|database-url-sentinel|jwt-private-key-sentinel|id-token-sentinel/i,
    )
  })
})
