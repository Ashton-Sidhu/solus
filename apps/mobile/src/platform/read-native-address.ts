import type { AddressAnswer } from '@solus/client-core/host-connection-check'

interface AddressRequest {
  readonly status: number
  readonly responseText: string
  open(method: string, url: string): void
  send(): void
  abort(): void
  addEventListener(type: 'load' | 'error' | 'timeout', listener: () => void): void
}

/** React Native puts the native error in responseText; fetch replaces it with a generic TypeError. */
export function readNativeAddress(
  url: string,
  signal: AbortSignal,
  createRequest: () => AddressRequest = () => new XMLHttpRequest(),
): Promise<AddressAnswer> {
  if (signal.aborted) return Promise.resolve({ kind: 'timeout' })
  return new Promise((resolve) => {
    const request = createRequest()
    let finished = false
    const finish = (answer: AddressAnswer) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      resolve(answer)
    }
    const abort = () => {
      finish({ kind: 'timeout' })
      request.abort()
    }
    request.addEventListener('load', () => finish({ kind: 'status', status: request.status }))
    request.addEventListener('error', () => finish({ kind: 'no-answer', error: request.responseText || 'Network request failed' }))
    request.addEventListener('timeout', () => finish({ kind: 'timeout' }))
    signal.addEventListener('abort', abort, { once: true })
    try {
      request.open('GET', url)
      request.send()
    } catch (error) {
      finish({ kind: 'no-answer', error: error instanceof Error ? error.message : 'Network request failed' })
    }
  })
}
