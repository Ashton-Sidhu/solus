export type DevShutdownSignal = 'SIGINT' | 'SIGTERM'

interface SignalSource {
  once(signal: DevShutdownSignal, listener: () => void): unknown
  off(signal: DevShutdownSignal, listener: () => void): unknown
}

interface DevShutdownOptions {
  signalSource: SignalSource
  shutdown(): Promise<void>
  quit(): void
  onError(signal: DevShutdownSignal, error: unknown): void
}

/** Gracefully stop Electron when the electron-vite launcher receives Ctrl-C. */
export function installDevShutdownHandlers(options: DevShutdownOptions): void {
  let shuttingDown = false
  const handlers = new Map<DevShutdownSignal, () => void>()

  const handle = (signal: DevShutdownSignal) => {
    if (shuttingDown) return
    shuttingDown = true
    for (const [registeredSignal, listener] of handlers) {
      options.signalSource.off(registeredSignal, listener)
    }

    void options.shutdown()
      .catch((error) => options.onError(signal, error))
      .finally(() => options.quit())
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const listener = () => handle(signal)
    handlers.set(signal, listener)
    options.signalSource.once(signal, listener)
  }
}
