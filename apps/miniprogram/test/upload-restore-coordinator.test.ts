import { describe, expect, it, vi } from 'vitest'

import {
  UploadRestoreCoordinator,
  type UploadRestoreController,
} from '../miniprogram/services/upload-restore-coordinator.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('UploadRestoreCoordinator', () => {
  it('restores every retained record sequentially and single-flights duplicate calls', async () => {
    const gates = [deferred<'uploaded'>(), deferred<'none'>()] as const
    let active = 0
    let maximumActive = 0
    const order: string[] = []
    const controllerFor = vi.fn((key: string): UploadRestoreController => {
      const index = order.length
      return {
        restore: async () => {
          order.push(key)
          active += 1
          maximumActive = Math.max(maximumActive, active)
          const gate = gates[index]
          if (gate === undefined) throw new Error('missing restore gate')
          const outcome = await gate.promise
          active -= 1
          return outcome
        },
        pause: vi.fn(() => Promise.resolve()),
        foreground: vi.fn(() => Promise.resolve()),
      }
    })
    const coordinator = new UploadRestoreCoordinator({
      retainedKeys: () => ['first', 'second'],
      controllerFor,
    })

    const firstCall = coordinator.restoreAll()
    const duplicateCall = coordinator.restoreAll()
    expect(duplicateCall).toBe(firstCall)
    await vi.waitFor(() => {
      expect(order).toEqual(['first'])
    })
    gates[0].resolve('uploaded')
    await vi.waitFor(() => {
      expect(order).toEqual(['first', 'second'])
    })
    gates[1].resolve('none')

    await expect(firstCall).resolves.toBe(2)
    expect(controllerFor).toHaveBeenCalledTimes(2)
    expect(maximumActive).toBe(1)
  })

  it('latches background state before a controller exists and foregrounds the active restore', async () => {
    const gate = deferred<'uploaded'>()
    const pause = vi.fn(() => Promise.resolve())
    const foreground = vi.fn(() => Promise.resolve())
    const coordinator = new UploadRestoreCoordinator({
      retainedKeys: () => ['only'],
      controllerFor: () => ({
        restore: () => gate.promise,
        pause,
        foreground,
      }),
    })

    await coordinator.pause()
    const restoring = coordinator.restoreAll()
    await vi.waitFor(() => {
      expect(pause).toHaveBeenCalledOnce()
    })
    await coordinator.foreground()

    expect(foreground).toHaveBeenCalledOnce()
    gate.resolve('uploaded')
    await expect(restoring).resolves.toBe(1)
  })

  it('does not leave the next record paused during a foreground handoff', async () => {
    const firstGate = deferred<'uploaded'>()
    const secondGate = deferred<'uploaded'>()
    const secondPause = vi.fn(() => Promise.resolve())
    const secondForeground = vi.fn(() => Promise.resolve())
    let index = 0
    const coordinator = new UploadRestoreCoordinator({
      retainedKeys: () => ['first', 'second'],
      controllerFor: () => {
        index += 1
        if (index === 1) {
          return {
            restore: () => firstGate.promise,
            pause: vi.fn(() => Promise.resolve()),
            foreground: async () => {
              firstGate.resolve('uploaded')
              await Promise.resolve()
            },
          }
        }
        return {
          restore: () => secondGate.promise,
          pause: secondPause,
          foreground: secondForeground,
        }
      },
    })

    await coordinator.pause()
    const restoring = coordinator.restoreAll()
    await coordinator.foreground()
    await vi.waitFor(() => {
      expect(index).toBe(2)
    })

    expect(secondPause).not.toHaveBeenCalled()
    expect(secondForeground).not.toHaveBeenCalled()
    secondGate.resolve('uploaded')
    await expect(restoring).resolves.toBe(2)
  })

  it('continues with later records when one retained record is poisoned', async () => {
    const poisoned = new Error('invalid retained server response')
    const restoreSecond = vi.fn(() => Promise.resolve<'uploaded'>('uploaded'))
    const coordinator = new UploadRestoreCoordinator({
      retainedKeys: () => ['poisoned', 'healthy'],
      controllerFor: (key) => ({
        restore: key === 'poisoned' ? () => Promise.reject(poisoned) : restoreSecond,
        pause: vi.fn(() => Promise.resolve()),
        foreground: vi.fn(() => Promise.resolve()),
      }),
    })

    await expect(coordinator.restoreAll()).rejects.toBe(poisoned)
    expect(restoreSecond).toHaveBeenCalledOnce()
  })
})
