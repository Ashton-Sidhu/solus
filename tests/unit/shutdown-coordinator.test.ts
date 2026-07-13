import { describe, expect, test } from 'bun:test'
import { createShutdownCoordinator } from '../../src/main/shutdown-coordinator'

describe('shutdown coordinator', () => {
  test('cleanup gets a chance to finish before Electron quits', async () => {
    let finishShutdown!: () => void
    const shutdownFinished = new Promise<void>((resolve) => { finishShutdown = resolve })
    let confirmQuit!: () => void
    const quitCalled = new Promise<void>((resolve) => { confirmQuit = resolve })
    const calls: string[] = []
    const coordinator = createShutdownCoordinator({
      shutdown: async () => {
        calls.push('shutdown')
        await shutdownFinished
      },
      quit: () => {
        calls.push('quit')
        confirmQuit()
      },
      forceQuit: () => calls.push('force-quit'),
      onError: () => calls.push('error'),
    })

    coordinator.requestQuit()
    expect(calls).toEqual(['shutdown'])
    expect(coordinator.isQuitting).toBe(false)

    finishShutdown()
    await quitCalled
    expect(calls).toEqual(['shutdown', 'quit'])
    expect(coordinator.isQuitting).toBe(true)
  })

  test('still quits when cleanup fails', async () => {
    const errors: unknown[] = []
    let confirmQuit!: () => void
    const quitCalled = new Promise<void>((resolve) => { confirmQuit = resolve })
    const coordinator = createShutdownCoordinator({
      shutdown: async () => { throw new Error('close failed') },
      quit: confirmQuit,
      forceQuit: () => {},
      onError: (error) => errors.push(error),
    })

    coordinator.requestQuit()
    await quitCalled

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  test('a second quit request exits immediately when cleanup is stuck', () => {
    let forceQuitCount = 0
    const coordinator = createShutdownCoordinator({
      shutdown: () => new Promise(() => {}),
      quit: () => {},
      forceQuit: () => { forceQuitCount++ },
      onError: () => {},
    })

    coordinator.requestQuit()
    coordinator.requestQuit()

    expect(forceQuitCount).toBe(1)
    expect(coordinator.isQuitting).toBe(true)
  })

  test('quits after the cleanup deadline', async () => {
    let confirmQuit!: () => void
    const quitCalled = new Promise<void>((resolve) => { confirmQuit = resolve })
    const coordinator = createShutdownCoordinator({
      shutdown: () => new Promise(() => {}),
      quit: confirmQuit,
      forceQuit: () => {},
      onError: () => {},
      gracePeriodMs: 1,
    })

    coordinator.requestQuit()
    await quitCalled

    expect(coordinator.isQuitting).toBe(true)
  })
})
