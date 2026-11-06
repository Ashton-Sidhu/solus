/**
 * One HTTP request to a Solus server outside the RPC layer (plans/032 D1): the
 * cloud, or another host before a socket exists. It sets the headers, encodes the
 * body, applies the timeout, and asks the token source once more after a 401.
 * It does not decode bodies; the route table that owns the schema does.
 */

const DEFAULT_TIMEOUT_MS = 15_000

/** Any status (a 401 too, after the one retry), no token to send, or no answer. */
export type HttpResult =
  | { kind: 'response'; response: Response }
  | { kind: 'signed-out' }
  | { kind: 'unreachable' }

/**
 * The token to send. `refused` names the token the server just refused, so the
 * source does not give it out again. Null when there is no sign-in. It matches
 * `OAuthSession.accessToken` and `WebTokenSession.accessToken` with the resource bound.
 */
export type HttpTokenSource = (options: { refused?: string }) => Promise<string | null>

export interface HttpClientOptions {
  /** The origin and path prefix every request path is joined to. */
  baseUrl: string
  /** Absent for a request that sends no credential. */
  token?: HttpTokenSource
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface HttpRequest {
  method?: string
  /** Sent as JSON when not undefined. */
  body?: unknown
  headers?: HeadersInit
  signal?: AbortSignal
}

export interface HttpClient {
  request(path: string, init?: HttpRequest): Promise<HttpResult>
}

/** The result in the shape the account route tables' `send` ports take: null when nothing answered. */
export function sentOf(result: HttpResult): Response | null | 'signed-out' {
  if (result.kind === 'response') return result.response
  return result.kind === 'signed-out' ? 'signed-out' : null
}

export function httpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const send = async (url: string, init: HttpRequest, token: string | null): Promise<Response | null> => {
    const headers = new Headers(init.headers)
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    if (token) headers.set('authorization', `Bearer ${token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      return await fetchImpl(url, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: 'omit',
        cache: 'no-store',
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      })
    } catch {
      return null
    }
  }

  return {
    async request(path, init = {}) {
      const url = `${options.baseUrl.replace(/\/+$/, '')}${path}`
      if (!options.token) {
        const response = await send(url, init, null)
        return response ? { kind: 'response', response } : { kind: 'unreachable' }
      }
      const token = await options.token({})
      if (!token) return { kind: 'signed-out' }
      const first = await send(url, init, token)
      if (!first) return { kind: 'unreachable' }
      if (first.status !== 401) return { kind: 'response', response: first }
      const fresh = await options.token({ refused: token })
      if (!fresh || fresh === token) return { kind: 'response', response: first }
      await first.body?.cancel().catch(() => undefined)
      const second = await send(url, init, fresh)
      return second ? { kind: 'response', response: second } : { kind: 'unreachable' }
    },
  }
}
