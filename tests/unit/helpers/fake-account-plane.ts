import { base64Url } from '@solus/client-core/oauth-session'
import { ACCESS_TOKEN_TYPE, ACCOUNT_AUDIENCE, SOLUS_API_AUDIENCE, TOKEN_EXCHANGE_GRANT_TYPE } from '@solus/contracts/uplink'

/**
 * A small authorization server for client tests: discovery, the token endpoint
 * (authorization code with PKCE; refresh for the servers token, `[account, api]`,
 * with rotation and replay detection that ends the grant; token exchange of the
 * servers token for one host's token), revocation, and `/userinfo`. It keeps the order of
 * every call, so a test can say what happened when.
 */

export const ISSUER = 'https://account.test'

export interface PlaneCall {
  path: string
  form: URLSearchParams
}

export interface FakeAccountPlaneOptions {
  clientId?: string
  identity?: { sub: string; email: string; email_verified: boolean; name?: string; picture?: string }
  /** Lets a test hold a refresh until it says so. */
  gateRefresh?: () => Promise<void>
  /** Lets a test hold an exchange until it says so. */
  gateExchange?: (resource: string) => Promise<void>
}

function jwt(payload: object): string {
  const encode = (value: object) => base64Url(new TextEncoder().encode(JSON.stringify(value)))
  return `${encode({ alg: 'ES256', kid: 'k1' })}.${encode(payload)}.c2ln`
}

export function fakeAccountPlane(options: FakeAccountPlaneOptions = {}) {
  const clientId = options.clientId ?? 'solus-desktop'
  const identity = options.identity ?? { sub: 'user-1', email: 'ada@example.test', email_verified: true, name: 'Ada' }
  const calls: PlaneCall[] = []
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>()
  /** Refresh tokens: true while live. */
  const refreshTokens = new Map<string, boolean>()
  /** The servers tokens issued, with the refresh token each came from: one is taken while that grant lives. */
  const serversTokens = new Map<string, string>()
  let serial = 0
  let now = Date.now()
  let isDown = false
  /** Each refused resource and the token endpoint's answer for it. */
  const refusedResources = new Map<string, { [key: string]: string }>()
  let userinfoName = identity.name

  const issueIdToken = (nonce?: string) => jwt({ iss: ISSUER, aud: clientId, exp: Math.floor(now / 1000) + 300, iat: Math.floor(now / 1000), ...identity, ...(nonce ? { nonce } : {}) })
  /** The grant lives while any refresh token of it does: a sign-out revokes the live one, a replay ends them all. */
  const grantLives = (): boolean => [...refreshTokens.values()].some(Boolean)
  const newRefreshToken = () => {
    const token = `rt-${++serial}`
    refreshTokens.set(token, true)
    return token
  }
  const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  async function sha256(text: string): Promise<string> {
    return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
  }

  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    calls.push({ path: url.pathname, form })
    if (isDown) throw new TypeError('fetch failed')
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return json(200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${ISSUER}/api/auth/oauth2/token`,
          userinfo_endpoint: `${ISSUER}/api/auth/oauth2/userinfo`,
          revocation_endpoint: `${ISSUER}/api/auth/oauth2/revoke`,
        })
      case '/api/auth/oauth2/token': {
        if (form.get('client_id') !== clientId) return json(401, { error: 'invalid_client' })
        if (form.get('grant_type') === 'authorization_code') {
          const code = codes.get(form.get('code') ?? '')
          codes.delete(form.get('code') ?? '')
          if (!code || code.redirectUri !== form.get('redirect_uri') || code.challenge !== await sha256(form.get('code_verifier') ?? '')) {
            return json(400, { error: 'invalid_grant' })
          }
          return json(200, { access_token: `at-signin`, expires_in: 300, refresh_token: newRefreshToken(), id_token: issueIdToken(code.nonce) })
        }
        if (form.get('grant_type') === 'refresh_token') {
          await options.gateRefresh?.()
          const presented = form.get('refresh_token') ?? ''
          const live = refreshTokens.get(presented)
          if (live === undefined) return json(400, { error: 'invalid_grant' })
          if (!live) {
            // Replay: the whole family ends.
            for (const token of refreshTokens.keys()) refreshTokens.set(token, false)
            return json(400, { error: 'invalid_grant' })
          }
          const resources = form.getAll('resource').sort()
          if (resources.join(' ') !== [ACCOUNT_AUDIENCE, SOLUS_API_AUDIENCE].sort().join(' ')) return json(400, { error: 'invalid_target' })
          const refusal = resources.map((resource) => refusedResources.get(resource)).find(Boolean)
          if (refusal) return json(400, refusal)
          refreshTokens.set(presented, false)
          const next = newRefreshToken()
          const accessToken = `at-${++serial}-${ACCOUNT_AUDIENCE}+${SOLUS_API_AUDIENCE}`
          serversTokens.set(accessToken, next)
          return json(200, { access_token: accessToken, expires_in: 300, refresh_token: next })
        }
        if (form.get('grant_type') === TOKEN_EXCHANGE_GRANT_TYPE) {
          const resource = form.get('resource') ?? ''
          await options.gateExchange?.(resource)
          if (form.get('subject_token_type') !== ACCESS_TOKEN_TYPE) return json(400, { error: 'invalid_request' })
          const family = serversTokens.get(form.get('subject_token') ?? '')
          // A grant that ended (sign-out, replay) takes none of its tokens: the next refresh says so.
          if (!family || !grantLives()) return json(401, { error: 'invalid_token' })
          const refusal = refusedResources.get(resource)
          if (refusal) return json(400, refusal)
          return json(200, { access_token: `at-${++serial}-${resource}`, expires_in: 300 })
        }
        return json(400, { error: 'unsupported_grant_type' })
      }
      case '/api/auth/oauth2/revoke':
        refreshTokens.set(form.get('token') ?? '', false)
        return new Response(null, { status: 200 })
      case '/api/auth/oauth2/userinfo':
        return json(200, { ...identity, name: userinfoName })
    }
    return json(404, { error: 'not_found' })
  }

  return {
    clientId,
    calls,
    fetch: fetchImpl,
    now: () => now,
    advance(ms: number) { now += ms },
    setDown(down: boolean) { isDown = down },
    refuse(resource: string, answer: { [key: string]: string } = { error: 'invalid_target' }) { refusedResources.set(resource, answer) },
    allow(resource: string) { refusedResources.delete(resource) },
    renameInUserinfo(name: string) { userinfoName = name },
    isLive(token: string) { return refreshTokens.get(token) === true },
    liveTokens() { return [...refreshTokens].filter(([, live]) => live).map(([token]) => token) },
    /** The browser step: the person approves, and the plane answers the redirect with a code. */
    approve(authorizeUrl: URL): URL {
      const query = authorizeUrl.searchParams
      const code = `code-${++serial}`
      codes.set(code, { challenge: query.get('code_challenge') ?? '', nonce: query.get('nonce') ?? '', redirectUri: query.get('redirect_uri') ?? '' })
      const callback = new URL(query.get('redirect_uri') ?? '')
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', query.get('state') ?? '')
      return callback
    },
    idToken: issueIdToken,
    /** Tokens as a device grant gives them. */
    deviceTokens() {
      return { access_token: 'at-device', expires_in: 300, refresh_token: newRefreshToken(), id_token: issueIdToken() }
    },
  }
}
