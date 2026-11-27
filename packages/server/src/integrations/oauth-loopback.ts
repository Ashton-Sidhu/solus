import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTEGRATION_OAUTH_LOOPBACK_PATH, INTEGRATION_OAUTH_LOOPBACK_PORT } from '@solus/contracts/integrations/oauth-callback'

/** The page a callback answers with. */
export interface LoopbackCallbackPage {
  status: number
  html: string
}

export class IntegrationCallbackPortBusyError extends Error {
  constructor() {
    super(`Solus needs port ${INTEGRATION_OAUTH_LOOPBACK_PORT} to finish this sign-in, and another program uses it. Close that program and try again.`)
    this.name = 'IntegrationCallbackPortBusyError'
  }
}

/**
 * The loopback listener of MCP sign-ins (docs/plans/mcp-oauth-callback.md):
 * `GET /callback` on 127.0.0.1, apart from the Solus server, so it never
 * takes a route of the web client and is never reachable from the network.
 * The owner of the flows opens it for a sign-in and closes it when no
 * sign-in waits on it.
 *
 * When the fixed port is in use it binds a port the system picks. A server
 * that registers Solus dynamically accepts that; an exact-match client (the
 * metadata document, an owner's OAuth app) does not, and its caller refuses.
 */
export class LoopbackCallbackListener {
  private server: Server | null = null
  private opening: Promise<string> | null = null

  constructor(
    private readonly port: number,
    private readonly answer: (params: URLSearchParams) => Promise<LoopbackCallbackPage>,
  ) {}

  /** The redirect URI it answers on, once it listens. */
  open(): Promise<string> {
    if (this.server) return Promise.resolve(redirectUriOf(this.server))
    this.opening ??= this.bind(this.port)
      .catch((error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' && this.port !== 0 ? this.bind(0) : Promise.reject(error)))
      .then((server) => {
        this.server = server
        return redirectUriOf(server)
      })
      .finally(() => { this.opening = null })
    return this.opening
  }

  close(): void {
    this.server?.close()
    this.server?.closeIdleConnections()
    this.server = null
  }

  private bind(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        // No kept-alive socket may outlive the listener: the port is free once it closes.
        if (request.method !== 'GET' || url.pathname !== INTEGRATION_OAUTH_LOOPBACK_PATH) {
          response.writeHead(404, { connection: 'close' }).end('Not found')
          return
        }
        void this.answer(url.searchParams).then((page) => {
          response.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
          response.end(page.html)
        })
      })
      server.once('error', reject)
      // Loopback only: this port must never be reachable from the network.
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve(server)
      })
    })
  }
}

function redirectUriOf(server: Server): string {
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${INTEGRATION_OAUTH_LOOPBACK_PATH}`
}
