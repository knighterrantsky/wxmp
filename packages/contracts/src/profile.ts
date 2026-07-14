import { Type, type Static } from '@sinclair/typebox'

import { DateTimeSchema, PublicIdSchema, strictObject, successEnvelopeSchema } from './envelope.js'

const NICKNAME_ALLOWED_PATTERN =
  '^[^\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]+$'

export const NicknameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: NICKNAME_ALLOWED_PATTERN,
})

export const PublicUserSchema = strictObject({
  id: PublicIdSchema,
  nickname: Type.Union([NicknameSchema, Type.Null()]),
  nicknameConfirmed: Type.Boolean(),
  nicknameConfirmedAt: Type.Optional(Type.Union([DateTimeSchema, Type.Null()])),
  createdAt: DateTimeSchema,
  updatedAt: Type.Optional(DateTimeSchema),
})

export const NicknameRequestSchema = strictObject({
  nickname: NicknameSchema,
  source: Type.Literal('wechatNicknameInput'),
  confirmed: Type.Literal(true),
})

export const ProfileResponseDataSchema = strictObject({
  user: PublicUserSchema,
})

export const ProfileResponseSchema = successEnvelopeSchema(ProfileResponseDataSchema)
export const NicknameResponseSchema = ProfileResponseSchema

export type PublicUser = Static<typeof PublicUserSchema>
export type NicknameRequest = Static<typeof NicknameRequestSchema>
export type ProfileResponse = Static<typeof ProfileResponseSchema>
