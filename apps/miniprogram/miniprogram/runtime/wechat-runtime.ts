import { loginWithWechatRuntime, type WxLoginSource } from './wx-auth.js'
import { requestWithWechatRuntime, type WxRequestSource } from './wx-http.js'
import {
  getWechatStorage,
  removeWechatStorage,
  setWechatStorage,
  type WxStorageSource,
} from './wx-storage.js'

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  headers?: Record<string, string>
  data?: unknown
}

export interface HttpResponse<T> {
  statusCode: number
  data: T
  headers: Record<string, string>
}

export interface WechatAuthRuntime {
  login(): Promise<{ code: string }>
}

export interface WechatHttpRuntime {
  request<T>(request: HttpRequest, decode?: (value: unknown) => T): Promise<HttpResponse<T>>
}

export interface WechatStorageRuntime {
  getStorage<T>(key: string, decode?: (value: unknown) => T): T | undefined
  setStorage<T>(key: string, value: T, encode?: (value: T) => unknown): void
  removeStorage(key: string): void
}

/**
 * Core runtime capabilities. Task-specific media, file, and upload capabilities
 * can extend this interface without coupling session code to those APIs.
 */
export interface WechatRuntime extends WechatAuthRuntime, WechatHttpRuntime, WechatStorageRuntime {}

export type WechatRuntimeSource = WxLoginSource & WxRequestSource & WxStorageSource

export function createWechatRuntime(
  source: WechatRuntimeSource = wx as unknown as WechatRuntimeSource,
): WechatRuntime {
  return {
    login: () => loginWithWechatRuntime(source),
    request: <T>(request: HttpRequest, decode?: (value: unknown) => T) =>
      requestWithWechatRuntime(source, request, decode),
    getStorage: <T>(key: string, decode?: (value: unknown) => T) =>
      getWechatStorage(source, key, decode),
    setStorage: <T>(key: string, value: T, encode?: (value: T) => unknown) => {
      setWechatStorage(source, key, value, encode)
    },
    removeStorage: (key: string) => {
      removeWechatStorage(source, key)
    },
  }
}
