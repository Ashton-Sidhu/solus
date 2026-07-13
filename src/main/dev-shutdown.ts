export type DevShutdownSignal = 'SIGINT' | 'SIGTERM'

interface SignalSource {
  on(signal: DevShutdownSignal, listener: () => void): unknown
  off(signal: DevShutdownSignal, listener: () => void): unknown
}

interface DevShutdownOptions {
  signalSource: SignalSource
  shutdown(): Promise<void>
  quit(): void
  onError(signal: DevShutdownSignal, error: unknown): void
  gracePeriodMs?: number
}

/** Gracefully stop Electron when the electron-vite launcher receives Ctrl-C. */
export function installDevShutdownHandlers(options: DevShutdownOptions): void {
  let shuttingDown = false
  let finished = false
  let shutdownTimeout: ReturnType<typeof setTimeout> | null = null
  const handlers = new Map<DevShutdownSignal, () => void>()

  const finish = () => {
    if (finished) return
    finished = true
    if (shutdownTimeout) clearTimeout(shutdownTimeout)
    for (const [registeredSignal, listener] of handlers) {
      options.signalSource.off(registeredSignal, listener)
    }
    options.quit()
  }

  const handle = (signal: DevShutdownSignal) => {
    if (shuttingDown) {
      finish()
      return
    }
    shuttingDown = true

    shutdownTimeout = setTimeout(finish, options.gracePeriodMs ?? 2_000)

    void options.shutdown()
      .catch((error) => options.onError(signal, error))
      .finally(finish)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const listener = () => handle(signal)
    handlers.set(signal, listener)
    options.signalSource.on(signal, listener)
  }
}
