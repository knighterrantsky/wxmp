export interface WechatIdentity {
  readonly openid: string
  readonly unionid?: string
}

export interface WechatExchangeOptions {
  readonly signal?: AbortSignal
}

export interface WechatGateway {
  exchangeCode(code: string, options?: WechatExchangeOptions): Promise<WechatIdentity>
}
