import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import { z } from 'zod'
import type { AtlassianOAuthCompleted } from '@solus/contracts/atlassian'
import { createLogger } from '../logger'
import { ATLASSIAN_CLIENT_ID } from './client-id'
import { ATLASSIAN_CLIENT_SECRET } from './client-secret'
import {
  clearCredential,
  loadCredential,
  persistCredential,
  type AtlassianStoredCredential,
} from './token-store'

const log = createLogger('main', 'atlassian-oauth')

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize'
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token'
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources'

/**
 * Atlassian allows exactly one callback URL per app and matches it character
 * for character — no wildcards, no variable port. So Solus binds one fixed
 * loopback port for the duration of a sign-in, which is the ordinary desktop
 * OAuth pattern, and registers that exact URL.
 *
 * A fixed port is the price of the exact-match rule. Nothing listens here
 * except while a sign-in is in flight.
 */
export const CALLBACK_PORT = 51789
const CALLBACK_PATH = '/oauth/atlassian/callback'
export const REGISTERED_REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

/**
 * `offline_access` is what makes the grant survive the first hour. The rest is
 * the v1 field scope: read and write docs and issues, and identify the user.
 *
 * The two Confluence generations need different scope styles, and Solus calls
 * both. Page and space CRUD runs on the v2 API, which accepts only *granular*
 * scopes — a classic scope there is refused with `401 Unauthorized; scope does
 * not match`, not a 403, which makes it read like a broken token. CQL search
 * has no v2 endpoint, so it stays on v1 and keeps its classic scopes.
 *
 * Adding a scope invalidates nothing, but an existing grant does not gain it:
 * the user has to sign in again, and the app registration has to offer it.
 */
const OAUTH_SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  // Confluence v2 — pages and spaces.
  'read:space:confluence',
  'read:page:confluence',
  'write:page:confluence',
  // Confluence v1 — CQL search only.
  'read:confluence-content.all',
  'search:confluence',
  'offline_access',
]

const PENDING_FLOW_TTL_MS = 5 * 60_000
/** Refresh this far before expiry so a call never races the clock. */
const REFRESH_MARGIN_MS = 60_000

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
})

const accessibleResourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string().optional(),
  scopes: z.array(z.string()).optional(),
})

interface PendingFlow {
  verifier: string
  expiresAt: number
}

/** Keyed by the state nonce. In memory only: a flow that does not complete
 *  within the TTL is meant to be lost. */
const pendingFlows = new Map<string, PendingFlow>()

export class AtlassianOAuthUnconfiguredError extends Error {
  constructor() {
    super('This Solus build ships no Atlassian OAuth client, so it cannot connect to Atlassian.')
    this.name = 'AtlassianOAuthUnconfiguredError'
  }
}

export function isOAuthConfigured(): boolean {
  return ATLASSIAN_CLIENT_ID !== '' && ATLASSIAN_CLIENT_SECRET !== ''
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function cleanupExpiredFlows(now = Date.now()): void {
  for (const [state, flow] of pendingFlows) {
    if (flow.expiresAt < now) pendingFlows.delete(state)
  }
}

interface AtlassianOAuthStartResult {
  authUrl: string
  expiresAt: number
}

interface AtlassianOAuthFlowOptions {
  /** Test seam for the fixed-port listener. Production always uses the real
   * loopback listener; unit tests can exercise flow state without binding it. */
  listenForCallback?: () => Promise<void>
}

export class AtlassianCallbackPortBusyError extends Error {
  constructor() {
    super(`Solus needs port ${CALLBACK_PORT} to finish an Atlassian sign-in, and something else is using it. Close that program and try again.`)
    this.name = 'AtlassianCallbackPortBusyError'
  }
}

/**
 * Opens a sign-in: mints PKCE material and starts listening on the one
 * registered loopback port for the single callback that ends it.
 *
 * Returns as soon as the URL is ready. The grant lands later, on the listener,
 * and is announced through `setOAuthCompletedListener` — so nothing waits on a
 * promise the user may never resolve.
 */
export async function startOAuthFlow(
  options: AtlassianOAuthFlowOptions = {},
): Promise<AtlassianOAuthStartResult> {
  if (!isOAuthConfigured()) throw new AtlassianOAuthUnconfiguredError()
  cleanupExpiredFlows()
  // One listener represents one browser flow. Once a new attempt takes its
  // place, no callback from an older tab may spend the new listener.
  stopListening()
  pendingFlows.clear()

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(24))
  const expiresAt = Date.now() + PENDING_FLOW_TTL_MS

  await (options.listenForCallback ?? listenForCallback)()
  pendingFlows.set(state, { verifier, expiresAt })
  activeCallbackTimer = setTimeout(() => {
    pendingFlows.clear()
    stopListening()
    onCompleted?.({
      connected: false,
      error: 'The Atlassian sign-in expired. Try again.',
    })
  }, PENDING_FLOW_TTL_MS)
  activeCallbackTimer.unref?.()

  const authUrl = new URL(AUTHORIZE_URL)
  authUrl.search = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: ATLASSIAN_CLIENT_ID,
    scope: OAUTH_SCOPES.join(' '),
    redirect_uri: REGISTERED_REDIRECT_URI,
    state,
    response_type: 'code',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  return { authUrl: authUrl.toString(), expiresAt }
}

type OAuthCompletedListener = (event: AtlassianOAuthCompleted) => void

let onCompleted: OAuthCompletedListener | null = null
let activeCallbackServer: Server | null = null
let activeCallbackTimer: ReturnType<typeof setTimeout> | null = null

/** Wired once at startup so a finished sign-in reaches every mounted client. */
export function setOAuthCompletedListener(listener: OAuthCompletedListener): void {
  onCompleted = listener
}

function stopListening(): void {
  if (activeCallbackTimer) {
    clearTimeout(activeCallbackTimer)
    activeCallbackTimer = null
  }
  activeCallbackServer?.close()
  activeCallbackServer = null
}

/**
 * Binds the one registered port until a callback arrives, the flow expires, or
 * a new sign-in supersedes this one. Bound only while a sign-in is in flight,
 * so Solus does not hold a fixed port for its whole lifetime.
 */
function listenForCallback(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', REGISTERED_REDIRECT_URI)
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('Not found')
        return
      }
      void completeOAuthCallback(url.searchParams).then((outcome) => {
        const page = renderOAuthResult(outcome)
        response.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8' })
        response.end(page.html)
        stopListening()
        const event: AtlassianOAuthCompleted = { connected: outcome.kind === 'connected' }
        if (outcome.kind !== 'connected') event.error = page.title
        onCompleted?.(event)
      })
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      activeCallbackServer = null
      reject(error.code === 'EADDRINUSE' ? new AtlassianCallbackPortBusyError() : error)
    })
    // Loopback only: this port must never be reachable from the network.
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      activeCallbackServer = server
      resolve()
    })
  })
}

/** Abandons an in-flight sign-in and frees the port. */
export function cancelOAuthFlow(): void {
  stopListening()
  pendingFlows.clear()
}

export type AtlassianOAuthCallbackOutcome =
  | { kind: 'connected'; siteUrl: string; products: Array<'confluence' | 'jira'> }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'no-sites' }
  | { kind: 'failed'; error: string }

export async function completeOAuthCallback(params: URLSearchParams): Promise<AtlassianOAuthCallbackOutcome> {
  cleanupExpiredFlows()

  const state = params.get('state')
  const flow = state ? pendingFlows.get(state) : undefined
  if (!state || !flow) return { kind: 'expired' }
  pendingFlows.delete(state)

  if (params.get('error')) return { kind: 'denied' }
  const code = params.get('code')
  if (!code) return { kind: 'failed', error: 'Atlassian did not return an authorization code.' }

  try {
    const token = await exchange({
      grant_type: 'authorization_code',
      client_id: ATLASSIAN_CLIENT_ID,
      client_secret: ATLASSIAN_CLIENT_SECRET,
      code,
      redirect_uri: REGISTERED_REDIRECT_URI,
      code_verifier: flow.verifier,
    })
    if (!token.refresh_token) {
      return { kind: 'failed', error: 'Atlassian did not grant offline access, so the connection could not be kept.' }
    }

    const site = await resolvePrimarySite(token.access_token)
    if (!site) return { kind: 'no-sites' }

    const granted = token.scope?.split(' ') ?? []
    const credential: AtlassianStoredCredential = {
      siteUrl: site.url,
      cloudId: site.id,
      products: productsFromScopes(granted),
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      scopes: granted,
    }
    if (site.name) credential.siteName = site.name
    persistCredential(credential)
    return { kind: 'connected', siteUrl: site.url, products: credential.products }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn('atlassian_oauth_callback_failed', { error })
    return { kind: 'failed', error }
  }
}

interface AtlassianOAuthResultPage {
  status: 200 | 400
  title: string
  html: string
}

/**
 * The page the browser lands on. Every arm names what to do next, because this
 * tab is the last thing the user sees before they go back to Solus.
 */
interface OAuthResultCopy {
  status: 200 | 400
  title: string
  body: string
}

function oauthResultCopy(outcome: AtlassianOAuthCallbackOutcome): OAuthResultCopy {
  switch (outcome.kind) {
    case 'connected':
      return { status: 200, title: "You're connected", body: `Solus can now reach ${outcome.siteUrl}. Return to Solus to continue.` }
    case 'denied':
      return { status: 400, title: 'Connection cancelled', body: 'Nothing was changed. Return to Solus when you are ready to try again.' }
    case 'expired':
      return { status: 400, title: 'This sign-in expired', body: 'A sign-in is only valid for five minutes. Return to Solus and start it again.' }
    case 'no-sites':
      return { status: 400, title: 'No Atlassian site found', body: 'This account is not associated with a Jira or Confluence site, so there is nothing for Solus to connect to.' }
    case 'failed':
      return { status: 400, title: 'Connection failed', body: outcome.error }
  }
}

function renderOAuthResult(outcome: AtlassianOAuthCallbackOutcome): AtlassianOAuthResultPage {
  const page = oauthResultCopy(outcome)
  return { status: page.status, title: page.title, html: resultPageHtml(page.title, page.body) }
}

function resultPageHtml(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(420px, calc(100vw - 48px)); border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 18px; padding: 32px; box-shadow: 0 24px 70px color-mix(in srgb, CanvasText 12%, transparent); }
    h1 { font-size: 1.35rem; line-height: 1.2; margin: 0 0 10px; letter-spacing: 0; }
    p { font-size: 0.95rem; line-height: 1.6; margin: 0; color: color-mix(in srgb, CanvasText 68%, transparent); }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Which products the grant can actually reach. Derived from granted scopes
 * rather than probed, because the authorization server has already decided —
 * a scope the user declined is a product Solus must not offer.
 */
function productsFromScopes(scopes: string[]): Array<'confluence' | 'jira'> {
  const products: Array<'confluence' | 'jira'> = []
  if (scopes.some((scope) => scope.includes('jira'))) products.push('jira')
  if (scopes.some((scope) => scope.includes('confluence'))) products.push('confluence')
  return products
}

interface AuthorizationCodeExchange {
  grant_type: 'authorization_code'
  client_id: string
  client_secret: string
  code: string
  redirect_uri: string
  code_verifier: string
}

interface RefreshTokenExchange {
  grant_type: 'refresh_token'
  client_id: string
  client_secret: string
  refresh_token: string
}

/** Atlassian names the reason a grant was refused (`invalid_grant`,
 *  `invalid_client`, …). Without it a 400 is undiagnosable — an expired refresh
 *  token and a mismatched client secret look identical. */
const tokenErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
})

/** A refusal from the token endpoint, carrying enough to decide whether the
 *  grant is dead (4xx) or the network merely failed (anything else). */
class AtlassianTokenRejectedError extends Error {
  constructor(readonly status: number, reason: string) {
    super(reason)
    this.name = 'AtlassianTokenRejectedError'
  }
}

async function exchange(
  body: AuthorizationCodeExchange | RefreshTokenExchange,
): Promise<z.infer<typeof tokenResponseSchema>> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const parsed = await response.json()
      .then((payload) => tokenErrorSchema.safeParse(payload))
      .catch(() => null)
    const reason = parsed?.success
      ? [parsed.data.error, parsed.data.error_description].filter(Boolean).join(': ')
      : ''
    throw new AtlassianTokenRejectedError(
      response.status,
      reason
        ? `Atlassian rejected the token request (HTTP ${response.status}): ${reason}`
        : `Atlassian rejected the token request (HTTP ${response.status}).`,
    )
  }
  return tokenResponseSchema.parse(await response.json())
}

interface AtlassianSite {
  id: string
  url: string
  name?: string
}

async function resolvePrimarySite(accessToken: string): Promise<AtlassianSite | null> {
  const response = await fetch(RESOURCES_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Could not list Atlassian sites (HTTP ${response.status}).`)
  const sites = z.array(accessibleResourceSchema).parse(await response.json())
  // One account, one site (see the plan). A second site is a second connection,
  // which the cloudId-keyed external keys already allow.
  return sites[0] ?? null
}

/**
 * The refresh in flight, shared by every caller that arrives while it runs.
 *
 * Atlassian rotates the refresh token on every use and invalidates the previous
 * one immediately. Two concurrent refreshes therefore spend the same token
 * twice: the first succeeds, the second is answered `invalid_grant` — a 4xx,
 * which this module treats as a dead grant and discards. A single expired token
 * plus a burst of parallel calls could that way cost the user the whole
 * connection. One in-flight refresh, shared, is the only safe number.
 */
let refreshInFlight: Promise<AtlassianStoredCredential | null> | null = null

/**
 * Returns a credential whose access token is valid now, refreshing and
 * persisting first if it is not.
 *
 * Every consumer must load through this rather than `loadCredential`, or it will
 * eventually use an expired token.
 */
export async function currentCredential(): Promise<AtlassianStoredCredential | null> {
  const credential = loadCredential()
  if (!credential) return null
  if (credential.expiresAt - REFRESH_MARGIN_MS > Date.now()) return credential

  const current = refreshInFlight
  if (current) return current
  const pending = refreshCredential(credential).finally(() => {
    if (refreshInFlight === pending) refreshInFlight = null
  })
  refreshInFlight = pending
  return pending
}

async function refreshCredential(
  credential: AtlassianStoredCredential,
): Promise<AtlassianStoredCredential | null> {
  try {
    const token = await exchange({
      grant_type: 'refresh_token',
      client_id: ATLASSIAN_CLIENT_ID,
      client_secret: ATLASSIAN_CLIENT_SECRET,
      refresh_token: credential.refreshToken,
    })
    const refreshed: AtlassianStoredCredential = {
      ...credential,
      accessToken: token.access_token,
      // Atlassian rotates the refresh token on every use and invalidates the
      // old one. Failing to store the new one loses the grant silently.
      refreshToken: token.refresh_token ?? credential.refreshToken,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    }
    persistCredential(refreshed)
    return refreshed
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // A grant Atlassian has refused outright will never work again: the refresh
    // token rotates on every use, so a rejected one cannot be retried. Keeping
    // it would leave every surface reporting a connection that cannot make a
    // single call — which is exactly how an empty Jira project list came to read
    // as "no projects on the connected site". Drop it, so the UI offers the one
    // thing that helps: signing in again.
    //
    // A network failure or a 5xx is not that, and must not cost the user their
    // connection.
    const rejected = err instanceof AtlassianTokenRejectedError && err.status >= 400 && err.status < 500
    if (rejected) clearCredential()
    log.warn('atlassian_token_refresh_failed', { error, discardedGrant: rejected })
    return null
  }
}
