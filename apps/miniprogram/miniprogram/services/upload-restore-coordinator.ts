export type UploadRestoreOutcome = 'none' | 'uploaded' | 'replace'

export interface UploadRestoreController {
  restore(): Promise<UploadRestoreOutcome>
  pause(): Promise<void>
  foreground(): Promise<void>
}

export interface UploadRestoreCoordinatorOptions {
  readonly retainedKeys: () => readonly string[]
  readonly controllerFor: (retainedKey: string) => UploadRestoreController
}

export class UploadRestoreCoordinator {
  readonly #retainedKeys: () => readonly string[]
  readonly #controllerFor: (retainedKey: string) => UploadRestoreController
  #active: UploadRestoreController | undefined
  #operation: Promise<number> | undefined
  #backgrounded = false

  constructor(options: UploadRestoreCoordinatorOptions) {
    this.#retainedKeys = options.retainedKeys
    this.#controllerFor = options.controllerFor
  }

  restoreAll(): Promise<number> {
    if (this.#operation !== undefined) return this.#operation
    const operation = this.#execute()
    this.#operation = operation
    void operation
      .finally(() => {
        if (this.#operation === operation) this.#operation = undefined
      })
      .catch(() => undefined)
    return operation
  }

  async pause(): Promise<void> {
    this.#backgrounded = true
    await this.#active?.pause()
  }

  async foreground(): Promise<void> {
    this.#backgrounded = false
    const active = this.#active
    try {
      if (active !== undefined) await active.foreground()
    } catch (error) {
      this.#backgrounded = true
      throw error
    }
  }

  async #execute(): Promise<number> {
    const keys = [...new Set(this.#retainedKeys())]
    let restored = 0
    let firstError: Error | undefined
    try {
      for (const key of keys) {
        const controller = this.#controllerFor(key)
        this.#active = controller
        try {
          if (this.#backgrounded) await controller.pause()
          await controller.restore()
          restored += 1
        } catch (error) {
          firstError ??= error instanceof Error ? error : new Error('Upload restore failed')
        } finally {
          if (this.#active === controller) this.#active = undefined
        }
      }
      if (firstError !== undefined) throw firstError
      return restored
    } finally {
      this.#active = undefined
    }
  }
}
