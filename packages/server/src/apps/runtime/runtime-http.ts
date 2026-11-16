import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import {
  APP_MANAGEMENT_PATHS,
  APP_MANAGEMENT_SIGNATURE_HEADER,
  APP_VISITOR_HEADER,
  APP_VISITOR_PATHS,
  APP_WEBHOOK_PATH_PREFIX,
  appManagementOperationSchema,
  appVersionPushSchema,
  appVisitorCallSchema,
  appVisitorEnterSchema,
  type AppDeploymentStatus,
  type AppRuntimeHealth,
  type AppVersionPushReceipt,
} from '@solus/contracts/app-deployments'
import { createLogger } from '../../logger'
import { AppRuntimeRefusal, type AppRuntime, type AppVisitor } from './app-runtime'
import { verifyManagementRequest } from './management-signature'

const log = createLogger('apps', 'runtime-http.ts')

/**
 * The HTTP listener of a deployment (docs/plans/app-deploy.md §5.1). It has
 * three doors. The management API (§5.3) is what Solus asks of the deployment,
 * each request signed with the app key. The address (§7) is what a visitor's
 * browser asks: the app's UI, and the calls of that UI. A visitor comes in
 * with the link of the app, with a sign-in to Solus, or with nothing when the
 * app is public. The third door is for another service: a webhook that the
 * app declares (§7.4).
 */

/** A version holds a built UI and a backend module: the limits of a build are 8 MiB each. */
const MAX_VERSION_BYTES = 32 * 1024 * 1024
/** One call of the UI: an operation's input, or one part of a file. */
const MAX_CALL_BYTES = 9 * 1024 * 1024
/** A webhook's request, as the webhook owner of a host limits it. */
const MAX_WEBHOOK_BYTES = 1024 * 1024
const SESSION_COOKIE = 'solus_app_session'
/** What a sign-in keeps in the browser until Solus Cloud sends it back: ten minutes. */
const SIGN_IN_COOKIE = 'solus_app_sign_in'
const SIGN_IN_SECONDS = 600
const EVENTS_PING_MS = 25_000

class HttpProblem extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > limit) throw new HttpProblem(413, 'The request is too large.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

/** What the listener writes as JSON: an answer of one of its doors, or why there is none. */
type RuntimeAnswer = AppDeploymentStatus | AppVersionPushReceipt | AppRuntimeHealth | { ok: true; value?: z.infer<ReturnType<typeof z.json>> } | { ok: false; error: string } | { error: string }

function send(response: ServerResponse, status: number, body: RuntimeAnswer, headers: { [name: string]: string } = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers })
  response.end(text)
}

function sendPage(response: ServerResponse, status: number, html: string, connect: readonly string[] = []): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    // The page is one built file with its scripts and styles in it. It reaches this deployment and the hosts the app names.
    'content-security-policy': `default-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob: https:; connect-src 'self' ${connect.map((host) => `https://${host}`).join(' ')}; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  response.end(html)
}

function parseJson(body: Buffer): z.infer<ReturnType<typeof z.json>> {
  try {
    return z.json().parse(JSON.parse(body.toString('utf8')))
  } catch {
    throw new HttpProblem(400, 'The request is not JSON.')
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
}

/** One cookie of a request; null with none. */
function cookieOf(request: IncomingMessage, cookie: string): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === cookie) return value.join('=')
  }
  return null
}

/** A cookie that only this deployment reads. Behind a proxy that ends TLS (the Tailscale sidecar, Solus Cloud), it is for HTTPS only. */
function setCookie(request: IncomingMessage, name: string, value: string, maxAgeSeconds: number): string {
  const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
}

function redirect(response: ServerResponse, location: string, cookies: readonly string[]): void {
  response.setHeader('set-cookie', [...cookies])
  response.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  response.end()
}

/**
 * What Solus puts in the page of an app (`window.solusApp`, see the
 * `@solus/app` module of an app project): here, calls go to this deployment
 * over HTTP, and the events come as server-sent events.
 */
const BRIDGE = `<script>(() => {
  const listeners = new Set()
  const post = async (body) => {
    const response = await fetch(${JSON.stringify(APP_VISITOR_PATHS.call)}, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ${JSON.stringify(APP_VISITOR_HEADER)}: '1' }, body: JSON.stringify(body) })
    const answer = await response.json().catch(() => null)
    if (!answer || !answer.ok) throw new Error((answer && answer.error) || 'The app did not answer.')
    return answer.value
  }
  const save = (file) => {
    const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: file.type }))
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return null
  }
  window.solusApp = {
    call: async (name, args) => (name === '@client/save' ? save(args) : post({ name, argumentsJson: JSON.stringify(args || {}) })),
    on: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  new EventSource(${JSON.stringify(APP_VISITOR_PATHS.events)}).addEventListener('data-changed', () => { for (const listener of listeners) listener('data-changed') })
})()</script>`

/** The page a browser gets when it has no session: it changes the secret in the link for one, or says that the app is private. */
function enterPage(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(name)}</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#2a2618;background:#fffffd}@media(prefers-color-scheme:dark){body{color:#ededed;background:#1b1b1b}}main{max-width:32ch;text-align:center}</style></head>
<body><main><p id="message">Opening…</p></main><script>(async () => {
  const secret = location.hash.slice(1)
  const message = document.getElementById('message')
  if (/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    const response = await fetch(${JSON.stringify(APP_VISITOR_PATHS.enter)}, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ${JSON.stringify(APP_VISITOR_HEADER)}: '1' }, body: JSON.stringify({ secret }) }).catch(() => null)
    if (response && response.ok) {
      history.replaceState(null, '', location.pathname)
      location.reload()
      return
    }
    message.textContent = 'This link does not open the app. Ask its owner for the link of now.'
    return
  }
  message.textContent = 'This app is private. Open it with its link.'
})()</script></body></html>`
}

/** The page of an app for named people, for a browser with no session: one way in, which the visitor chooses. */
function signInPage(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(name)}</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#2a2618;background:#fffffd}@media(prefers-color-scheme:dark){body{color:#ededed;background:#1b1b1b}}main{max-width:32ch;text-align:center}a{display:inline-block;margin-top:8px;padding:8px 16px;border-radius:8px;background:#d97757;color:#fff;text-decoration:none;font-weight:500}a:focus-visible{outline:2px solid #d97757;outline-offset:3px}</style></head>
<body><main><p>${escapeHtml(name)} is shared with people of Solus.</p><a href="${APP_VISITOR_PATHS.signIn}">Sign in with Solus</a></main></body></html>`
}

function messagePage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}</style></head><body><p>${escapeHtml(text)}</p></body></html>`
}

/** The app's page with the bridge in it, before each script of the app. */
function withBridge(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  return head ? `${html.slice(0, head.index + head[0].length)}${BRIDGE}${html.slice(head.index + head[0].length)}` : `${BRIDGE}${html}`
}

export interface RuntimeHttpOptions {
  runtime: AppRuntime
  /** The app key that signs each management request; null answers none. */
  appKey: string | null
  now?: () => number
}

/** One signed request of the management API (§5.3). */
async function answerManagement(runtime: AppRuntime, method: string, route: string, body: Buffer): Promise<RuntimeAnswer> {
  if (route === APP_MANAGEMENT_PATHS.status && method === 'GET') return runtime.status()
  if (route === APP_MANAGEMENT_PATHS.operations && method === 'POST') {
    const call = appManagementOperationSchema.safeParse(parseJson(body))
    if (!call.success) throw new HttpProblem(400, 'The call is not valid.')
    try {
      return { ok: true, value: z.json().parse(await runtime.callOperation(call.data)) }
    } catch (error) {
      if (error instanceof AppRuntimeRefusal) throw error
      // The app's own failure is the answer of the call: the model reads it.
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (route === APP_MANAGEMENT_PATHS.versions && method === 'POST') {
    const push = appVersionPushSchema.safeParse(parseJson(body))
    if (!push.success) throw new HttpProblem(400, `The version is not valid: ${z.prettifyError(push.error)}`)
    return runtime.receiveVersion(push.data)
  }
  throw new HttpProblem(404, 'Not found.')
}

/** The app's page for a browser at the address: the UI for a visitor who is in, or the way in. */
async function answerPage(runtime: AppRuntime, visitor: AppVisitor | null, response: ServerResponse): Promise<void> {
  const ui = await runtime.ui()
  if (!visitor) return sendPage(response, 401, runtime.accessMode() === 'people' ? signInPage(ui?.name ?? 'App') : enterPage(ui?.name ?? 'App'))
  if (!ui) return sendPage(response, 404, messagePage('App', 'This app has no page.'))
  sendPage(response, 200, withBridge(ui.html), ui.network)
}

/** The two steps of a sign-in (§7.3), each a navigation of the browser: out to Solus Cloud, and back with a code. */
async function answerSignIn(runtime: AppRuntime, request: IncomingMessage, response: ServerResponse, route: string, query: URLSearchParams): Promise<void> {
  if (route === APP_VISITOR_PATHS.signIn) {
    const started = runtime.signInStart()
    if (!started) throw new HttpProblem(404, 'Not found.')
    return redirect(response, started.location, [setCookie(request, SIGN_IN_COOKIE, started.pending, SIGN_IN_SECONDS)])
  }
  const finished = await runtime.signInFinish(query.get('code') ?? '', query.get('state') ?? '', cookieOf(request, SIGN_IN_COOKIE))
  if ('refusal' in finished) return sendPage(response, 403, messagePage('App', finished.refusal))
  redirect(response, '/', [setCookie(request, SESSION_COOKIE, finished.session, finished.maxAgeSeconds), setCookie(request, SIGN_IN_COOKIE, '', 0)])
}

/** One request of the app's own page: a call, the events, or the secret of the link. A page of another origin cannot send the header. */
async function answerVisitor(runtime: AppRuntime, request: IncomingMessage, response: ServerResponse, route: string, visitor: AppVisitor | null): Promise<void> {
  const method = request.method ?? 'GET'
  if (route === APP_VISITOR_PATHS.events && method === 'GET') {
    if (!visitor) throw new HttpProblem(401, 'Open the app with its link.')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    response.write(': open\n\n')
    const stop = runtime.onDataChanged(() => response.write('event: data-changed\ndata: {}\n\n'))
    const ping = setInterval(() => response.write(': ping\n\n'), EVENTS_PING_MS)
    request.once('close', () => {
      clearInterval(ping)
      stop()
    })
    return
  }
  if (method !== 'POST' || request.headers[APP_VISITOR_HEADER] !== '1') throw new HttpProblem(404, 'Not found.')
  const body = parseJson(await readBody(request, MAX_CALL_BYTES))
  if (route === APP_VISITOR_PATHS.enter) {
    const entered = appVisitorEnterSchema.safeParse(body)
    const session = entered.success ? runtime.enter(entered.data.secret) : null
    if (!session) throw new HttpProblem(401, 'This link does not open the app.')
    return send(response, 200, { ok: true }, { 'set-cookie': setCookie(request, SESSION_COOKIE, session.session, session.maxAgeSeconds) })
  }
  if (route === APP_VISITOR_PATHS.leave) return send(response, 200, { ok: true }, { 'set-cookie': setCookie(request, SESSION_COOKIE, '', 0) })
  if (route === APP_VISITOR_PATHS.call) {
    if (!visitor) throw new HttpProblem(401, 'Open the app with its link.')
    const call = appVisitorCallSchema.safeParse(body)
    if (!call.success) throw new HttpProblem(400, 'The call is not valid.')
    try {
      const answer = z.object({ value: z.json() }).parse(JSON.parse(await runtime.uiCall(call.data.name, call.data.argumentsJson, visitor)))
      return send(response, 200, { ok: true, value: answer.value })
    } catch (error) {
      // The app's own failure is the answer of the call, for the app's UI to show.
      return send(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  throw new HttpProblem(404, 'Not found.')
}

/** The request handler of a deployment. `listenRuntime` puts it on a port; a test calls it on a port of its own. */
export function runtimeRequestHandler({ runtime, appKey, now = Date.now }: RuntimeHttpOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET'
    const path = request.url ?? '/'
    const [route = '/', search = ''] = path.split('?')
    if (route === APP_MANAGEMENT_PATHS.health && method === 'GET') return send(response, 200, await runtime.health())

    if (route.startsWith('/_solus/v1/')) {
      const body = await readBody(request, MAX_VERSION_BYTES)
      const signature = request.headers[APP_MANAGEMENT_SIGNATURE_HEADER]
      if (!appKey || !verifyManagementRequest(appKey, { method, path, body }, Array.isArray(signature) ? undefined : signature, now())) {
        throw new HttpProblem(401, 'This request is not signed by the Solus of this deployment.')
      }
      return send(response, 200, await answerManagement(runtime, method, route, body))
    }

    if (route.startsWith(APP_WEBHOOK_PATH_PREFIX)) {
      if (method !== 'POST') throw new HttpProblem(405, 'Use POST.')
      const headers = Object.entries(request.headers).flatMap(([name, value]): [string, string][] => (value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]]))
      const answered = await runtime.webhook(route.slice(APP_WEBHOOK_PATH_PREFIX.length), method, headers, new URLSearchParams(search), await readBody(request, MAX_WEBHOOK_BYTES))
      return send(response, answered.status, answered.error === null ? { ok: true } : { error: answered.error })
    }

    if (method === 'GET' && (route === APP_VISITOR_PATHS.signIn || route === APP_VISITOR_PATHS.callback)) return answerSignIn(runtime, request, response, route, new URLSearchParams(search))
    const visitor = runtime.visitorOf(cookieOf(request, SESSION_COOKIE))
    if (route.startsWith('/_solus/app/')) return answerVisitor(runtime, request, response, route, visitor)
    if (route.startsWith('/_solus/')) throw new HttpProblem(404, 'Not found.')
    // Each other path is a page of the app: its routes are after `#`, so one file answers them all.
    if (method !== 'GET') throw new HttpProblem(405, 'Use GET.')
    return answerPage(runtime, visitor, response)
  }

  return (request, response) => {
    answer(request, response).catch((error) => {
      if (response.headersSent) return response.end()
      if (error instanceof HttpProblem) return send(response, error.status, { error: error.message })
      if (error instanceof AppRuntimeRefusal) return send(response, 409, { error: error.message })
      log.error('app_runtime_request_failed', { error: error instanceof Error ? error.message : String(error) })
      send(response, 500, { error: 'The deployment could not answer.' })
    })
  }
}

export function listenRuntime(options: RuntimeHttpOptions, port: number, host = '0.0.0.0'): Promise<{ server: Server; port: number }> {
  const server = createServer(runtimeRequestHandler(options))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      // SAFETY: a listener on a TCP port answers an AddressInfo.
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}
