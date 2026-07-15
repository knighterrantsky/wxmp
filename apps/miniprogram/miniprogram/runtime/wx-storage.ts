export interface WxStorageSource {
  getStorageSync(key: string): unknown
  setStorageSync(key: string, value: unknown): void
  removeStorageSync(key: string): void
}

export function getWechatStorage<T>(
  source: WxStorageSource,
  key: string,
  decode?: (value: unknown) => T,
): T | undefined {
  const value = source.getStorageSync(key)
  if (value === undefined) return undefined
  return decode === undefined ? (value as T) : decode(value)
}

export function setWechatStorage<T>(
  source: WxStorageSource,
  key: string,
  value: T,
  encode?: (value: T) => unknown,
): void {
  source.setStorageSync(key, encode === undefined ? value : encode(value))
}

export function removeWechatStorage(source: WxStorageSource, key: string): void {
  source.removeStorageSync(key)
}
