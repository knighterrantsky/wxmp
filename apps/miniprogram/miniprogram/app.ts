import type { NicknameRequest, PublicUser } from '@wx-upload/contracts'

import { API_BASE_URL } from './config.generated.js'
import { createWechatRuntime, type WechatRuntime } from './runtime/wechat-runtime.js'
import { ApiClient } from './services/api-client.js'
import { SessionStore } from './services/session-store.js'

const INSTALLATION_ID_STORAGE_KEY = 'installationId'
const INSTALLATION_ID_PATTERN = /^installation-[0-9a-f]{32}$/u

interface ApplicationServices {
  readonly api: ApiClient
  readonly session: SessionStore
}

export interface ApplicationProfileApi {
  updateNickname(request: NicknameRequest): Promise<PublicUser>
}

export interface ApplicationGlobalData {
  readonly profileApi: ApplicationProfileApi
  publicUser?: PublicUser
  ensureSession: () => Promise<PublicUser>
}

let servicesPromise: Promise<ApplicationServices> | undefined

function hexadecimal(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, '0')).join('')
}

async function installationId(runtime: WechatRuntime): Promise<string> {
  const persisted = runtime.getStorage<unknown>(INSTALLATION_ID_STORAGE_KEY)
  if (typeof persisted === 'string' && INSTALLATION_ID_PATTERN.test(persisted)) {
    return persisted
  }
  if (persisted !== undefined) runtime.removeStorage(INSTALLATION_ID_STORAGE_KEY)

  const random = await wx.getRandomValues({ length: 16 })
  const generated = `installation-${hexadecimal(random.randomValues)}`
  runtime.setStorage(INSTALLATION_ID_STORAGE_KEY, generated)
  return generated
}

function applicationServices(): Promise<ApplicationServices> {
  if (servicesPromise === undefined) {
    const pending = (async () => {
      const runtime = createWechatRuntime()
      const api = new ApiClient({ runtime, baseUrl: API_BASE_URL })
      const deviceId = await installationId(runtime)
      return {
        api,
        session: new SessionStore({ runtime, api, deviceId }),
      }
    })()
    servicesPromise = pending
    void pending.catch(() => {
      if (servicesPromise === pending) servicesPromise = undefined
    })
  }
  return servicesPromise
}

const globalData: ApplicationGlobalData = {
  profileApi: {
    async updateNickname(request) {
      const { api, session } = await applicationServices()
      const user = await api.updateNickname(request, session)
      await session.replaceUser(user)
      globalData.publicUser = user
      return user
    },
  },

  async ensureSession() {
    const { session } = await applicationServices()
    const current = await session.ensureSession()
    globalData.publicUser = current.user
    return current.user
  },
}

App({
  globalData,

  onLaunch() {
    void this.globalData.ensureSession().catch(() => undefined)
  },
})
