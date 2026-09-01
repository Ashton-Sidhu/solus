interface ErrorStream {
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export interface BrokenPipeGuard {
  readonly isBroken: boolean
  write(callback: () => void): void
}

function isBrokenPipeError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE'
}

/**
 * A closed launcher pipe is a normal shutdown condition. Keep its asynchronous
 * stream error from becoming an uncaught exception, then skip later writes.
 */
export function installBrokenPipeGuard(stream: ErrorStream): BrokenPipeGuard {
  let isBroken = false

  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) {
      isBroken = true
      return
    }
    throw error
  })

  return {
    get isBroken() {
      return isBroken
    },
    write(callback) {
      if (isBroken) return
      try {
        callback()
      } catch (error) {
        if (isBrokenPipeError(error)) {
          isBroken = true
          return
        }
        throw error
      }
    },
  }
}
