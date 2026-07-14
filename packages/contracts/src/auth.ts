import { Type, type Static } from '@sinclair/typebox'

import { strictObject, successEnvelopeSchema } from './envelope.js'
import { PublicUserSchema } from './profile.js'

export const WechatLoginRequestSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  deviceId: Type.String({ minLength: 1, maxLength: 128 }),
})

export const TokenPairSchema = strictObject({
  accessToken: Type.String({ minLength: 1, maxLength: 4096 }),
  accessTokenExpiresIn: Type.Integer({ minimum: 1 }),
  refreshToken: Type.String({ minLength: 1, maxLength: 512 }),
  refreshTokenExpiresIn: Type.Integer({ minimum: 1 }),
})

export const WechatLoginResponseDataSchema = strictObject({
  ...TokenPairSchema.properties,
  isNewUser: Type.Boolean(),
  user: PublicUserSchema,
})

export const WechatLoginResponseSchema = successEnvelopeSchema(WechatLoginResponseDataSchema)

export const RefreshTokenRequestSchema = strictObject({
  refreshToken: Type.String({ minLength: 1, maxLength: 512 }),
})

export const RefreshTokenResponseSchema = successEnvelopeSchema(TokenPairSchema)
export const LogoutRequestSchema = RefreshTokenRequestSchema

export type WechatLoginRequest = Static<typeof WechatLoginRequestSchema>
export type WechatLoginResponse = Static<typeof WechatLoginResponseSchema>
export type RefreshTokenRequest = Static<typeof RefreshTokenRequestSchema>
export type RefreshTokenResponse = Static<typeof RefreshTokenResponseSchema>
