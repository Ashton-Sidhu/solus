import { createLogger } from '../../logger'
import { GITHUB_CLIENT_ID } from './client-id'
import { loadToken, persistToken, clearToken, type GithubStoredToken } from './token-store'
import type { AuthStatus, DeviceCodePrompt, ProviderAuth } from '../types'

const log = createLogger('main', 'github-auth')

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

// `repo` is intentionally coarse: OAuth Apps can't scope per-repo, and it's the
// minimum required to read private PRs and post reviews/comments as the user.
// `project` is mandatory for Projects v2 read/write (it is NOT covered by `repo`)
// — without it the task panel can't read or edit native due/priority/status.
// The connect UI states this plainly. Migrating to fine-grained perms is a
// GitHub-App swap behind ProviderAuth, not a rewrite of consumers.
const SCOPE = 'repo project'

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

async function postForm(url: string, body: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  })
  return { status: res.status, body: await res.text() }
}

async function getJson(url: string, token: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Solus',
    },
  })
  return {
    status: res.status,
    body: await res.text(),
    headers: { 'x-oauth-scopes': res.headers.get('x-oauth-scopes') ?? '' },
  }
}

/** Raised when connect() is cancelled, so consumers can distinguish it from a real failure. */
export class ConnectCancelledError extends Error {
  constructor() {
    super('GitHub connection was cancelled.')
    this.name = 'ConnectCancelledError'
  }
}

/** Sleep that resolves early when `signal` aborts, so cancellation isn't stuck waiting a poll tick. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: SCOPE })
  const res = await postForm(DEVICE_CODE_URL, params.toString())
  if (res.status !== 200) throw new Error(`Device code request failed: ${res.body}`)
  return JSON.parse(res.body) as DeviceCodeResponse
}

/**
 * Poll for the access token until the user authorizes, the code expires, or the
 * grant is denied. Honors GitHub's `authorization_pending` / `slow_down`
 * back-pressure protocol.
 */
async function pollForToken(deviceCode: string, intervalSeconds: number, expiresIn: number, signal: AbortSignal): Promise<GithubStoredToken> {
  let interval = intervalSeconds
  const deadline = Date.now() + expiresIn * 1000

  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal)
    if (signal.aborted) throw new ConnectCancelledError()
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT,
    })
    const res = await postForm(ACCESS_TOKEN_URL, params.toString())
    const data = JSON.parse(res.body) as {
      access_token?: string
      scope?: string
      error?: string
      interval?: number
    }

    if (data.access_token) {
      return { accessToken: data.access_token, scope: data.scope ?? SCOPE }
    }
    switch (data.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        // GitHub returns a new minimum interval; fall back to a +5s bump.
        interval = data.interval ?? interval + 5
        continue
      case 'expired_token':
        throw new Error('The device code expired before authorization completed.')
      case 'access_denied':
        throw new Error('Authorization was denied.')
      default:
        throw new Error(`GitHub authorization failed: ${data.error ?? res.body}`)
    }
  }
  throw new Error('The device code expired before authorization completed.')
}

async function fetchLogin(token: string): Promise<{ login: string; scopes: string }> {
  const res = await getJson(USER_URL, token)
  if (res.status !== 200) throw new Error(`Failed to fetch GitHub user: ${res.body}`)
  const user = JSON.parse(res.body) as { login: string }
  // `X-OAuth-Scopes` lists the scopes actually granted to *this* token — the
  // authoritative source. The device-flow token-exchange `scope` echo can lag
  // behind a re-authorization, so prefer the header (comma-separated).
  const scopes = (res.headers['x-oauth-scopes'] ?? '').trim()
  return { login: user.login, scopes }
}

/** The actual granted scopes are the source of truth (the token exchange returns
 *  them in `scope`), so derive them from the stored token rather than the
 *  *requested* SCOPE constant — a user who connected before `project` existed has
 *  only `repo`, and the UI must reflect that to offer a reconnect. GitHub returns
 *  scopes comma-separated; tolerate whitespace too for safety. */
function toStatus(token: GithubStoredToken | null): AuthStatus {
  if (!token) return { connected: false }
  return {
    connected: true,
    login: token.login,
    scopes: token.scope ? token.scope.split(/[,\s]+/).filter(Boolean) : undefined,
  }
}

/**
 * Device-flow auth for GitHub OAuth Apps. No client secret, no loopback server —
 * ideal for a distributed desktop binary. Tokens are non-expiring by default,
 * so getAccessToken() is just "load from disk, throw if absent".
 */
export class GitHubAuth implements ProviderAuth {
  private connecting = false
  private abort: AbortController | null = null

  async connect(onUserCode: (c: DeviceCodePrompt) => void): Promise<AuthStatus> {
    if (!GITHUB_CLIENT_ID) throw new Error('GitHub client ID not configured')
    if (this.connecting) throw new Error('A GitHub connection is already in progress.')
    this.connecting = true
    this.abort = new AbortController()
    try {
      const device = await requestDeviceCode()
      onUserCode({
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        expiresIn: device.expires_in,
      })

      const token = await pollForToken(device.device_code, device.interval, device.expires_in, this.abort.signal)
      const { login, scopes } = await fetchLogin(token.accessToken)
      token.login = login
      // Trust the token's real granted scopes (header) over the exchange echo, so
      // the Projects-scope hint reflects what the token can actually do.
      if (scopes) token.scope = scopes
      persistToken(token)
      return toStatus(token)
    } finally {
      this.connecting = false
      this.abort = null
    }
  }

  cancelConnect(): void {
    this.abort?.abort()
  }

  async getAccessToken(): Promise<string> {
    const token = loadToken()
    if (!token) throw new Error('GitHub is not connected')
    return token.accessToken
  }

  async status(): Promise<AuthStatus> {
    return toStatus(loadToken())
  }

  disconnect(): void {
    clearToken()
    log.info('GitHub disconnected')
  }
}
