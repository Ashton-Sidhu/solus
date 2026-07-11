import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { installDevShutdownHandlers } from '../../src/main/dev-shutdown'

describe('development shutdown signals', () => {
  test('Ctrl-C drains the app before quitting and removes both signal handlers', async () => {
    const signals = new EventEmitter()
    let finishShutdown!: () => void
    const shutdownFinished = new Promise<void>((resolve) => { finishShutdown = resolve })
    let confirmQuit!: () => void
    const quitCalled = new Promise<void>((resolve) => { confirmQuit = resolve })
    const calls: string[] = []

    installDevShutdownHandlers({
      signalSource: signals,
      shutdown: async () => {
        calls.push('shutdown')
        await shutdownFinished
      },
      quit: () => {
        calls.push('quit')
        confirmQuit()
      },
      onError: () => calls.push('error'),
    })

    signals.emit('SIGINT')
    expect(calls).toEqual(['shutdown'])
    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)

    finishShutdown()
    await quitCalled
    expect(calls).toEqual(['shutdown', 'quit'])
  })

  test('still quits when graceful shutdown fails', async () => {
    const signals = new EventEmitter()
    const errors: Array<{ signal: string; error: unknown }> = []
    let quit = false

    installDevShutdownHandlers({
      signalSource: signals,
      shutdown: async () => { throw new Error('close failed') },
      quit: () => { quit = true },
      onError: (signal, error) => errors.push({ signal, error }),
    })

    signals.emit('SIGTERM')
    await Promise.resolve()
    await Promise.resolve()

    expect(errors).toHaveLength(1)
    expect(errors[0].signal).toBe('SIGTERM')
    expect(errors[0].error).toBeInstanceOf(Error)
    expect(quit).toBe(true)
  })
})
