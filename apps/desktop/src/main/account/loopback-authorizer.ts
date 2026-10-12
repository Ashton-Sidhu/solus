import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { BrowserAuthorization, BrowserAuthorizer } from '@solus/client-core/oauth-session'

/**
 * The desktop's browser step (RFC 8252 §7.3, loopback redirect): a one-shot HTTP
 * server on 127.0.0.1 and a free port, the system browser on the authorize page, and
 * exactly one `GET /callback` that carries the `state` of this sign-in. Any other
 * request is refused and the server keeps waiting; the right one gets a small page
 * that says the tab can close, and the server closes.
 */

/** How long the person has to finish signing in in the browser. */
export const LOOPBACK_TIMEOUT_MS = 10 * 60_000

export interface LoopbackAuthorizerDeps {
  /** Opens the authorize page in the system browser (`shell.openExternal`). */
  openExternal(url: string): Promise<void>
  timeoutMs?: number
}

const DONE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signed in to Solus</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 -apple-system, system-ui, sans-serif; background: light-dark(#fafafa, #111); color: light-dark(#111, #eee); }
  main { text-align: center; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  p { margin: 0; color: light-dark(#555, #aaa); }
</style></head>
<body><main><h1>You are signed in to Solus</h1><p>You can close this tab and go back to the app.</p></main></body></html>`

export function loopbackAuthorizer(deps: LoopbackAuthorizerDeps): BrowserAuthorizer {
  return {
    async start(): Promise<BrowserAuthorization> {
      const server = createServer()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      // SAFETY: a server listening on a TCP address answers `address()` with an AddressInfo.
      const { port } = server.address() as AddressInfo
      const redirectUri = `http://127.0.0.1:${port}/callback`
      let finish: (callback: URL | null) => void = () => {}
      const outcome = new Promise<URL | null>((resolve) => {
        let isDone = false
        const timer = setTimeout(() => finish(null), deps.timeoutMs ?? LOOPBACK_TIMEOUT_MS)
        finish = (callback) => {
          if (isDone) return
          isDone = true
          clearTimeout(timer)
          closeServer(server)
          resolve(callback)
        }
      })
      let expectedState: string | null = null
      server.on('request', (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? '/', redirectUri)
        if (request.method !== 'GET' || url.pathname !== '/callback' || !expectedState || url.searchParams.get('state') !== expectedState) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
          return
        }
        // The server closes once the page is sent, so the page arrives whole.
        response.once('finish', () => finish(url))
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(DONE_PAGE)
      })
      return {
        redirectUri,
        async complete(authorizeUrl) {
          expectedState = authorizeUrl.searchParams.get('state')
          try {
            await deps.openExternal(authorizeUrl.toString())
          } catch {
            finish(null)
          }
          return outcome
        },
        cancel: () => finish(null),
      }
    },
  }
}

function closeServer(server: Server): void {
  server.close()
  // A browser keeps its connection open; the server must not wait for it.
  server.closeAllConnections()
}
