/**
 * Reject rather than wait forever.
 *
 * `Debugger.sendCommand` has no timeout of its own. A guest that stops
 * answering can leave the promise pending for the life of the process.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  method: string,
  timeoutMs: number,
  detached?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onDetach: (() => void) | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The browser guest did not answer ${method} within ${timeoutMs}ms.`)),
          timeoutMs,
        )
        if (detached) {
          onDetach = () => reject(new Error('The frame under the pointer went away during the click.'))
          if (detached.aborted) onDetach()
          else detached.addEventListener('abort', onDetach, { once: true })
        }
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onDetach) detached?.removeEventListener('abort', onDetach)
  }
}
