export interface WxLoginSource {
  login(options: { success(result: { code: string }): void; fail(reason: unknown): void }): unknown
}

export function loginWithWechatRuntime(source: WxLoginSource): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    source.login({
      success(result) {
        if (typeof result.code !== 'string' || result.code.length === 0) {
          reject(new Error('WeChat login failed'))
          return
        }
        resolve({ code: result.code })
      },
      fail() {
        reject(new Error('WeChat login failed'))
      },
    })
  })
}
