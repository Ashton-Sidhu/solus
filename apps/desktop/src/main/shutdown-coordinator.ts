interface ShutdownCoordinatorOptions {
  shutdown(): Promise<void>
  quit(): void
  forceQuit(): void
  onError(error: Parameters<typeof String>[0]): void
  gracePeriodMs?: number
}

export interface ShutdownCoordinator {
  readonly isQuitting: boolean
  requestQuit(): void
}

/** Give application cleanup a short grace period, then always terminate. */
export function createShutdownCoordinator(options: ShutdownCoordinatorOptions): ShutdownCoordinator {
  let state: 'running' | 'cleaning' | 'quitting' = 'running'
  let shutdownTimeout: ReturnType<typeof setTimeout> | null = null

  const gracePeriodMs = options.gracePeriodMs ?? 2_000

  const finish = () => {
    if (state === 'quitting') return
    state = 'quitting'
    if (shutdownTimeout) clearTimeout(shutdownTimeout)
    options.quit()
    // A quit can still be cancelled after this point by a window or renderer
    // that vetoes its close. Cleanup already had its turn, so terminate anyway.
    setTimeout(options.forceQuit, gracePeriodMs).unref()
  }

  return {
    get isQuitting() {
      return state === 'quitting'
    },
    requestQuit() {
      if (state === 'cleaning') {
        state = 'quitting'
        if (shutdownTimeout) clearTimeout(shutdownTimeout)
        options.forceQuit()
        return
      }
      if (state === 'quitting') return

      state = 'cleaning'
      shutdownTimeout = setTimeout(finish, gracePeriodMs)
      void options.shutdown()
        .catch(options.onError)
        .finally(finish)
    },
  }
}
