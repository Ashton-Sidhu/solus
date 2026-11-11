import { request as httpRequest, type IncomingMessage } from 'node:http'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 10

/**
 * `fetch` for `gh config http_unix_socket`: `gh` signs in with a placeholder
 * token and a local proxy on that socket swaps in the real one. Every request
 * goes over the socket as plain HTTP with the API host in the Host header,
 * so nothing reaches GitHub directly. A redirect is followed on the same origin
 * only. A redirect to another origin is returned as it is: the proxy can only
 * sign requests for the API host.
 */
export function unixSocketFetch(socketPath: string): typeof fetch {
  const socketFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) throw new Error('GitHub socket fetch takes a URL, not a Request')
    let url = new URL(String(input))
    let method = (init?.method ?? 'GET').toUpperCase()
    // A Response reads every body form fetch accepts into bytes.
    let body: Buffer | null = init?.body == null ? null : Buffer.from(await new Response(init.body).arrayBuffer())
    const headers = new Headers(init?.headers)
    for (let redirects = 0; ; redirects++) {
      const response = await send(socketPath, url, method, headers, body, init?.signal ?? undefined)
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || !location || redirects >= MAX_REDIRECTS) return response
      const destination = new URL(location, url)
      if (destination.origin !== url.origin) return response
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET'
        body = null
        headers.delete('content-type')
        headers.delete('content-length')
      }
      url = destination
    }
  }
  // SAFETY: Octokit calls only the (input, init) signature; Bun's `fetch` type
  // adds a `preconnect` member that no GitHub client reads.
  return socketFetch as typeof fetch
}

function send(socketPath: string, url: URL, method: string, headers: Headers, body: Buffer | null, signal: AbortSignal | undefined): Promise<Response> {
  const outgoing: Record<string, string> = Object.fromEntries(headers)
  outgoing.host = url.host
  if (body) outgoing['content-length'] = String(body.length)
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ socketPath, method, path: `${url.pathname}${url.search}`, headers: outgoing, signal }, (incoming) => {
      readAll(incoming).then((bytes) => resolve(toResponse(incoming, bytes)), reject)
    })
    sent.once('error', reject)
    sent.end(body ?? undefined)
  })
}

async function readAll(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function toResponse(incoming: IncomingMessage, bytes: Buffer): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const status = incoming.statusCode ?? 502
  const noBody = status === 204 || status === 304 || bytes.length === 0
  return new Response(noBody ? null : new Uint8Array(bytes), { status, statusText: incoming.statusMessage, headers })
}
