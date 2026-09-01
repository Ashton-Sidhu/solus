import { randomBytes } from 'crypto'
import { join } from 'path'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { GOOGLE_CLIENT_ID } from './client-id'
import { GOOGLE_CLIENT_SECRET } from './client-secret'

const log = createLogger('main', 'google-oauth')

const TOKEN_KEY = 'google-oauth'

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const OAUTH_CALLBACK_PATH = '/oauth/google/callback'
const PENDING_FLOW_TTL_MS = 5 * 60_000
/** Fallback access-token lifetime (Google omits expiry_date on some responses). */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60_000 - 30_000

interface StoredToken {
  refreshToken: string
  accessToken: string
  expiresAt: number
}

interface PendingOAuthFlow {
  authUrl: string
  verifier: string
  redirectUri: string
  expiresAt: number
}

export interface GoogleOAuthStartOptions {
  callbackBaseUrl?: string
  fallbackHost: string
  fallbackPort: number
}

export interface GoogleOAuthStartResult {
  authUrl: string
  expiresAt: number
}

export interface GoogleOAuthCallbackResult {
  status: number
  html: string
}

const pendingFlows = new Map<string, PendingOAuthFlow>()

function tokenFile(): string {
  return join(dataDir(), 'google-oauth.bin')
}

function loadStored(): StoredToken | null {
  return secretStore().loadJson<StoredToken>(TOKEN_KEY, tokenFile())
}

function persist(token: StoredToken): void {
  try {
    secretStore().saveJson(TOKEN_KEY, tokenFile(), token)
  } catch (err) {
    log.warn(`Failed to persist token: ${err}`)
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function assertConfigured(): void {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google client ID not configured')
  if (!GOOGLE_CLIENT_SECRET) throw new Error('Google client secret not configured')
}

function oauthClient(redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri,
  })
}

export function validateOAuthStateNonce(
  expectedState: string | undefined,
  actualState: string | null,
  expiresAt: number | undefined,
  now = Date.now(),
): boolean {
  return !!expectedState && actualState === expectedState && typeof expiresAt === 'number' && now <= expiresAt
}

function cleanupExpiredPendingFlows(now = Date.now()): void {
  for (const [state, flow] of pendingFlows) {
    if (flow.expiresAt < now) pendingFlows.delete(state)
  }
}

function normalizeCallbackBaseUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function hostForUrl(host: string): string {
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

function buildRedirectUri(opts: GoogleOAuthStartOptions): string {
  const base = normalizeCallbackBaseUrl(opts.callbackBaseUrl)
    ?? `http://${hostForUrl(opts.fallbackHost)}:${opts.fallbackPort}`
  // Remote hosts must be registered as OAuth redirect URIs in the Google client
  // configuration, or reached through a tunnel whose public URL is registered.
  return `${base}${OAUTH_CALLBACK_PATH}`
}

export async function startGoogleOAuthFlow(opts: GoogleOAuthStartOptions): Promise<GoogleOAuthStartResult> {
  assertConfigured()

  cleanupExpiredPendingFlows()

  const redirectUri = buildRedirectUri(opts)
  const existing = [...pendingFlows.values()].find(flow => flow.redirectUri === redirectUri)
  if (existing) return { authUrl: existing.authUrl, expiresAt: existing.expiresAt }

  const client = oauthClient(redirectUri)
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
  const state = base64url(randomBytes(32))
  const expiresAt = Date.now() + PENDING_FLOW_TTL_MS

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPE,
    prompt: 'consent',
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
    state,
  })

  pendingFlows.set(state, { authUrl, verifier: codeVerifier, redirectUri, expiresAt })
  return { authUrl, expiresAt }
}

export async function completeGoogleOAuthCallback(params: URLSearchParams): Promise<GoogleOAuthCallbackResult> {
  cleanupExpiredPendingFlows()

  const state = params.get('state')
  const flow = state ? pendingFlows.get(state) : undefined
  if (!validateOAuthStateNonce(state ?? undefined, state, flow?.expiresAt)) {
    return callbackPage(400, 'Google connection expired', 'Return to Solus and start Google sign-in again.')
  }

  pendingFlows.delete(state!)

  const error = params.get('error')
  if (error) {
    return callbackPage(400, 'Google connection cancelled', 'Return to Solus when you are ready to try again.')
  }

  const code = params.get('code')
  if (!code) {
    return callbackPage(400, 'Google did not return a code', 'Return to Solus and start Google sign-in again.')
  }

  try {
    const client = oauthClient(flow!.redirectUri)
    const { tokens } = await client.getToken({ code, codeVerifier: flow!.verifier })
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Google did not return an access/refresh token')
    }
    persist({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ?? Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS,
    })
    return callbackPage(200, "You're connected", 'Return to Solus to continue.')
  } catch (err) {
    log.warn(`OAuth callback failed: ${err}`)
    return callbackPage(500, 'Google connection failed', 'Return to Solus and start Google sign-in again.')
  }
}

function callbackPage(status: number, title: string, message: string): GoogleOAuthCallbackResult {
  return {
    status,
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(420px, calc(100vw - 48px)); border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 18px; padding: 32px; box-shadow: 0 24px 70px color-mix(in srgb, CanvasText 12%, transparent); }
    .mark { width: 40px; height: 40px; border-radius: 999px; display: grid; place-items: center; background: #2563eb; color: white; font-weight: 700; margin-bottom: 20px; }
    h1 { font-size: 1.35rem; line-height: 1.2; margin: 0 0 10px; letter-spacing: 0; }
    p { font-size: 0.95rem; line-height: 1.6; margin: 0; color: color-mix(in srgb, CanvasText 68%, transparent); }
  </style>
</head>
<body>
  <main>
    <div class="mark">${status < 400 ? '&#10003;' : '!'}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`,
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function getAccessToken(): Promise<string | null> {
  assertConfigured()

  const stored = loadStored()
  if (!stored) return null

  const client = oauthClient()
  client.setCredentials({
    refresh_token: stored.refreshToken,
    access_token: stored.accessToken,
    expiry_date: stored.expiresAt,
  })
  // Google rotates the refresh token on some refreshes; persist whatever the
  // library obtains so we never fall back to a stale/revoked grant.
  client.on('tokens', (tokens) => {
    persist({
      accessToken: tokens.access_token ?? stored.accessToken,
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      expiresAt: tokens.expiry_date ?? Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS,
    })
  })

  try {
    // Returns the cached token when still valid, otherwise refreshes (and fires
    // the 'tokens' listener above) transparently.
    const { token } = await client.getAccessToken()
    return token ?? null
  } catch (err) {
    log.warn(`Refresh failed, re-authenticating: ${err}`)
    return null
  }
}

export function disconnect(): void {
  try {
    secretStore().remove(TOKEN_KEY, tokenFile())
  } catch {}
}
