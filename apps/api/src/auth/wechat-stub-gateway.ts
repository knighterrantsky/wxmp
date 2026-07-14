import { createHash } from 'node:crypto'

import { ApiError } from '../http/errors.js'
import type { WechatGateway, WechatIdentity } from './wechat-gateway.js'

const DEVELOPMENT_CODE = /^dev:([A-Za-z0-9._-]{1,64})$/u

export class WechatStubGateway implements WechatGateway {
  exchangeCode(code: string): Promise<WechatIdentity> {
    const match = DEVELOPMENT_CODE.exec(code)
    if (match === null) {
      return Promise.reject(
        new ApiError({
          code: 'WECHAT_CODE_INVALID',
          message: '微信登录凭据无效或已使用',
          statusCode: 401,
        }),
      )
    }
    const subject = match[1] ?? ''
    const digest = createHash('sha256')
      .update(`wx-upload-stub:${subject}`, 'utf8')
      .digest('hex')
      .slice(0, 48)
    return Promise.resolve({ openid: `stub_${digest}` })
  }
}
