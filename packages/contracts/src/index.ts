export * from './auth.js'
export * from './envelope.js'
export * from './errors.js'
export * from './profile.js'
export * from './upload.js'

import {
  LogoutRequestSchema,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
  WechatLoginRequestSchema,
  WechatLoginResponseSchema,
} from './auth.js'
import { ErrorEnvelopeSchema } from './errors.js'
import { NicknameRequestSchema, NicknameResponseSchema, ProfileResponseSchema } from './profile.js'
import {
  AbortUploadRequestSchema,
  AbortUploadResponseSchema,
  CompleteUploadRequestSchema,
  CompleteUploadResponseSchema,
  InitializeUploadRequestSchema,
  InitializeUploadResponseSchema,
  UploadDetailResponseSchema,
  UploadHistoryQuerySchema,
  UploadHistoryResponseSchema,
  UploadPartResponseSchema,
} from './upload.js'

export const PUBLIC_SCHEMAS = [
  ErrorEnvelopeSchema,
  WechatLoginRequestSchema,
  WechatLoginResponseSchema,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
  LogoutRequestSchema,
  ProfileResponseSchema,
  NicknameRequestSchema,
  NicknameResponseSchema,
  InitializeUploadRequestSchema,
  InitializeUploadResponseSchema,
  UploadPartResponseSchema,
  UploadDetailResponseSchema,
  CompleteUploadRequestSchema,
  CompleteUploadResponseSchema,
  AbortUploadRequestSchema,
  AbortUploadResponseSchema,
  UploadHistoryQuerySchema,
  UploadHistoryResponseSchema,
] as const
