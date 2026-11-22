interface GetRequest {
  readonly status: number
  readonly responseText: string
  addEventListener(type: 'load' | 'error' | 'timeout', listener: () => void): void
  open(method: string, url: string): void
  send(): void
  abort(): void
}

/**
 * A GET that keeps the system's error text. React Native's fetch turns every
 * failure into "Network request failed"; its XMLHttpRequest puts the native
 * error (for example the iOS App Transport Security refusal) in `responseText`.
 * Enough for a `/health` read; use `fetch` for everything else.
 */
export function nativeGet(
  input: string | URL | Request,
  init?: RequestInit,
  createRequest: () => GetRequest = () => new XMLHttpRequest(),
): Promise<Response> {
  const signal = init?.signal
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const request = createRequest()
    const abort = () => {
      request.abort()
      reject(signal?.reason)
    }
    const settle = () => signal?.removeEventListener('abort', abort)
    request.addEventListener('load', () => {
      settle()
      // A Response cannot carry status 0, which a request that got no HTTP answer reports.
      if (request.status === 0) reject(new TypeError(request.responseText || 'Network request failed'))
      else resolve(new Response(request.responseText, { status: request.status }))
    })
    request.addEventListener('error', () => {
      settle()
      reject(new TypeError(request.responseText || 'Network request failed'))
    })
    request.addEventListener('timeout', () => {
      settle()
      // Hermes has no DOMException; the name is what callers read.
      const timeout = new Error('The request timed out')
      timeout.name = 'TimeoutError'
      reject(timeout)
    })
    signal?.addEventListener('abort', abort, { once: true })
    request.open('GET', input instanceof Request ? input.url : String(input))
    request.send()
  })
}
