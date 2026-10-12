import { z } from 'zod'
import type { AccountState, SignInEnd } from '@solus/contracts/account-types'
import {
  SIGN_IN_SCOPES,
  identityClaimsSchema,
  tokenResourceUri,
  type AccountIdentity,
  type TokenResource,
} from '@solus/contracts/auth/clients'

/**
 * One sign-in of one Solus client to the account plane
 * (docs/adr/0001-standard-authentication.md §3.2): the authorization code with PKCE
 * through the system browser, OIDC identity, and five-minute access tokens for one
 * resource each, got with the refresh token. Desktop main, mobile, web, and the CLI
 * use this one implementation; each gives its platform parts (`BrowserAuthorizer`,
 * `TokenStore`) and its `fetch` and clock.
 *
 * The refresh token rotates at each refresh, and the account plane ends the whole
 * client grant when a used token comes again (§5, replay). So this class is the only
 * refresher of its grant: refreshes run one at a time, and each one saves the new
 * refresh token before it gives out the new access token.
 */

/** What a client keeps of its sign-in. */
export interface StoredGrant {
  refreshToken: string
  idToken: string
  identity: AccountIdentity
  signedInAt: number
}

/** A stored grant as a platform store reads it back; anything else reads as no sign-in. */
export const storedGrantSchema = z.object({
  refreshToken: z.string().min(1),
  idToken: z.string().min(1),
  identity: z.object({
    sub: z.string().min(1),
    email: z.string(),
    emailVerified: z.boolean(),
    name: z.string().nullable(),
    picture: z.string().nullable(),
  }),
  signedInAt: z.number(),
}) satisfies z.ZodType<StoredGrant>

/** The platform part: where the refresh token lives. */
export interface TokenStore {
  load(): StoredGrant | null
  save(grant: StoredGrant): void
  clear(): void
}

/** One browser step, started before the authorize address exists (the loopback port is known only then). */
export interface BrowserAuthorization {
  /** Where the browser comes back: desktop `http://127.0.0.1:<port>/callback`, mobile `solus://auth/callback`. */
  readonly redirectUri: string
  /** Opens `authorizeUrl`; the callback address, or null when the person closed it, it timed out, or it was cancelled. */
  complete(authorizeUrl: URL): Promise<URL | null>
  /** Stops the step; `complete` then resolves null. */
  cancel(): void
}

/** The platform part: how the browser step runs. */
export interface BrowserAuthorizer {
  start(): Promise<BrowserAuthorization>
}

/** What a sign-in must remember between the authorize request and its callback. */
export interface PendingSignIn {
  state: string
  nonce: string
  codeVerifier: string
  redirectUri: string
}

export interface OAuthSessionLog {
  info(event: string, data?: { [key: string]: string | number | boolean | null }): void
  warn(event: string, data?: { [key: string]: string | number | boolean | null }): void
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface OAuthSessionDeps {
  /** The account origin, which is also the issuer. */
  cloudOrigin: string
  clientId: string
  store: TokenStore
  /** Absent where the client runs the browser step itself (web: a top-level redirect). */
  authorizer?: BrowserAuthorizer
  fetch: FetchLike
  now: () => number
  log?: OAuthSessionLog
  /** Defaults to Web Crypto; a platform without it gives its own. */
  randomBytes?: (length: number) => Uint8Array
  sha256?: (data: Uint8Array) => Promise<Uint8Array>
}

/** An access token is given out until this long before its end. */
export const ACCESS_TOKEN_RENEW_LEAD_MS = 60_000
/** How long a call to the account plane may take. */
const REQUEST_TIMEOUT_MS = 15_000

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  userinfo_endpoint: z.url(),
  revocation_endpoint: z.url(),
})
type Discovery = z.infer<typeof discoverySchema>

/** A token endpoint answer (RFC 6749 §5.1). */
export const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
})
export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>

const tokenErrorSchema = z.object({ error: z.string() })

const idTokenSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nonce: z.string().optional(),
})

interface CachedToken {
  token: string
  expiresAt: number
}

export class OAuthSession {
  private current: AccountState
  private grant: StoredGrant | null
  private readonly cache = new Map<string, CachedToken>()
  private readonly inFlight = new Map<string, Promise<string | null>>()
  /** Every refresh runs after the one before it: the rotated refresh token is the next one's input. */
  private refreshChain: Promise<void> = Promise.resolve()
  private discoveryRead: Promise<Discovery> | null = null
  private authorization: BrowserAuthorization | null = null
  private isEnding = false
  private readonly listeners = new Set<(state: AccountState) => void>()

  constructor(private readonly deps: OAuthSessionDeps) {
    this.grant = deps.store.load()
    this.current = this.grant ? this.signedIn(this.grant, false) : { kind: 'signed-out' }
  }

  state(): AccountState {
    return this.current
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Reads the store again when no grant is held: a store can become readable after start (the desktop keychain). */
  reload(): void {
    if (this.grant) return
    const grant = this.deps.store.load()
    if (!grant) return
    this.grant = grant
    this.setState(this.signedIn(grant, false))
  }

  /** The browser step and the code exchange. */
  async signIn(): Promise<SignInEnd> {
    const authorizer = this.deps.authorizer
    if (!authorizer) return 'error'
    this.cancelSignIn()
    let authorization: BrowserAuthorization
    try {
      authorization = await authorizer.start()
    } catch (error) {
      this.log('warn', 'oauth_sign_in_ended', { end: 'error', reason: String(error) })
      return 'error'
    }
    this.authorization = authorization
    let begun: { authorizeUrl: URL; pending: PendingSignIn }
    try {
      begun = await this.beginSignIn(authorization.redirectUri)
    } catch (error) {
      authorization.cancel()
      if (this.authorization === authorization) this.authorization = null
      this.log('warn', 'oauth_sign_in_ended', { end: 'error', reason: String(error) })
      this.setState({ kind: 'invalid', reason: 'unreachable' })
      return 'error'
    }
    const callback = await authorization.complete(begun.authorizeUrl).catch(() => null)
    // Cancelled, or another sign-in took its place.
    if (this.authorization !== authorization) return 'cancelled'
    this.authorization = null
    if (!callback) {
      this.log('info', 'oauth_sign_in_ended', { end: 'cancelled' })
      this.restoreAfterSignIn()
      return 'cancelled'
    }
    return this.completeSignIn(callback, begun.pending)
  }

  /** Stops a running browser step. */
  cancelSignIn(): void {
    const authorization = this.authorization
    if (!authorization) return
    this.authorization = null
    authorization.cancel()
    this.restoreAfterSignIn()
  }

  /**
   * The authorize request, with a new `state`, `nonce`, and PKCE verifier. The web
   * client calls it itself and keeps `pending` across its top-level redirect.
   */
  async beginSignIn(redirectUri: string, options: { prompt?: 'none' } = {}): Promise<{ authorizeUrl: URL; pending: PendingSignIn }> {
    const discovery = await this.discovery()
    const pending: PendingSignIn = {
      state: this.randomToken(),
      nonce: this.randomToken(),
      codeVerifier: this.randomToken(),
      redirectUri,
    }
    const challenge = base64Url(await this.sha256(new TextEncoder().encode(pending.codeVerifier)))
    const authorizeUrl = new URL(discovery.authorization_endpoint)
    const query = authorizeUrl.searchParams
    query.set('response_type', 'code')
    query.set('client_id', this.deps.clientId)
    query.set('redirect_uri', redirectUri)
    query.set('scope', SIGN_IN_SCOPES.join(' '))
    query.set('state', pending.state)
    query.set('nonce', pending.nonce)
    query.set('code_challenge', challenge)
    query.set('code_challenge_method', 'S256')
    if (options.prompt) query.set('prompt', options.prompt)
    this.setState({ kind: 'signing-in', authorizeUrl: authorizeUrl.toString() })
    this.log('info', 'oauth_sign_in_started')
    return { authorizeUrl, pending }
  }

  /** The callback of one authorize request: checks its `state`, then exchanges the code. */
  async completeSignIn(callback: URL, pending: PendingSignIn): Promise<SignInEnd> {
    const query = callback.searchParams
    if (query.get('state') !== pending.state) return this.failSignIn('error', 'state_mismatch')
    const error = query.get('error')
    if (error) return this.failSignIn(error === 'access_denied' ? 'denied' : 'error', error)
    const code = query.get('code')
    if (!code) return this.failSignIn('error', 'no_code')
    let discovery: Discovery
    let response: Response
    try {
      discovery = await this.discovery()
      response = await this.post(discovery.token_endpoint, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: this.deps.clientId,
        code_verifier: pending.codeVerifier,
      })
    } catch (error) {
      this.log('warn', 'oauth_sign_in_ended', { end: 'error', reason: String(error) })
      this.setState({ kind: 'invalid', reason: 'unreachable' })
      return 'error'
    }
    if (!response.ok) return this.failSignIn('error', await errorCodeOf(response))
    const tokens = oauthTokenResponseSchema.safeParse(await response.json().catch(() => null))
    if (!tokens.success) return this.failSignIn('error', 'malformed_token_response')
    return this.adopt(tokens.data, discovery, pending.nonce)
  }

  /** Tokens a device grant gave (the CLI, RFC 8628): no browser step and no nonce. */
  async adoptTokens(tokens: OAuthTokenResponse): Promise<SignInEnd> {
    let discovery: Discovery
    try {
      discovery = await this.discovery()
    } catch (error) {
      return this.failSignIn('error', String(error))
    }
    return this.adopt(tokens, discovery, null)
  }

  /**
   * Revokes this client's refresh token (RFC 7009), then clears the store. A refresh
   * that runs finishes first, so the token revoked is the newest one. The store is
   * cleared even when the account plane does not answer.
   */
  async signOut(): Promise<void> {
    this.cancelSignIn()
    this.isEnding = true
    try {
      await this.refreshChain
      const grant = this.grant
      this.grant = null
      this.cache.clear()
      if (grant) {
        try {
          const discovery = await this.discovery()
          const response = await this.post(discovery.revocation_endpoint, {
            token: grant.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: this.deps.clientId,
          })
          if (!response.ok) this.log('warn', 'oauth_revoke_refused', { status: response.status })
        } catch (error) {
          this.log('warn', 'oauth_revoke_failed', { reason: String(error) })
        }
      }
      this.clearStore()
      this.setState({ kind: 'signed-out' })
      this.log('info', 'oauth_signed_out')
    } finally {
      this.isEnding = false
    }
  }

  /**
   * A valid access token for one resource. Kept until a minute before its end; `fresh`
   * asks for a new one (the resource refused the kept one). Null when signed out, when
   * the account plane refuses this resource, or when it does not answer.
   */
  accessToken(resource: TokenResource, options: { fresh?: boolean } = {}): Promise<string | null> {
    if (!this.grant || this.isEnding) return Promise.resolve(null)
    const uri = tokenResourceUri(resource)
    const cached = this.cache.get(uri)
    if (!options.fresh && cached && cached.expiresAt - ACCESS_TOKEN_RENEW_LEAD_MS > this.deps.now()) {
      return Promise.resolve(cached.token)
    }
    const running = this.inFlight.get(uri)
    if (running) return running
    this.cache.delete(uri)
    const turn = this.refreshChain.then(() => this.refresh(uri))
    this.refreshChain = turn.then(() => undefined, () => undefined)
    const answer: Promise<string | null> = turn.catch((error) => {
      this.log('warn', 'oauth_refresh_failed', { reason: String(error) })
      return null
    }).finally(() => {
      if (this.inFlight.get(uri) === answer) this.inFlight.delete(uri)
    })
    this.inFlight.set(uri, answer)
    return answer
  }

  /** Reads `/userinfo` again with an account-plane token; the ID token was the first source. */
  async refreshIdentity(): Promise<void> {
    const grant = this.grant
    if (!grant) return
    const token = await this.accessToken({ kind: 'account' })
    if (!token) return
    let response: Response
    try {
      const discovery = await this.discovery()
      response = await this.deps.fetch(discovery.userinfo_endpoint, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      this.markStale(true)
      return
    }
    if (!response.ok) {
      this.log('warn', 'oauth_userinfo_refused', { status: response.status })
      return
    }
    const identity = identityClaimsSchema.safeParse(await response.json().catch(() => null))
    // A sign-out or another sign-in during the read.
    if (!identity.success || !this.grant || this.grant.idToken !== grant.idToken) return
    this.grant = { ...this.grant, identity: identity.data }
    this.saveStore(this.grant)
    this.setState(this.signedIn(this.grant, false))
  }

  private async refresh(uri: string): Promise<string | null> {
    const grant = this.grant
    if (!grant || this.isEnding) return null
    let response: Response
    try {
      const discovery = await this.discovery()
      response = await this.post(discovery.token_endpoint, {
        grant_type: 'refresh_token',
        refresh_token: grant.refreshToken,
        client_id: this.deps.clientId,
        resource: uri,
      })
    } catch (error) {
      this.log('warn', 'oauth_refresh_unreachable', { resource: uri, reason: String(error) })
      this.markStale(true)
      return null
    }
    if (!response.ok) {
      const code = await errorCodeOf(response)
      if (code === 'invalid_grant') {
        // The grant was revoked (sign-out elsewhere, the Devices page) or replayed.
        this.log('info', 'oauth_grant_ended', { resource: uri })
        this.endGrant(grant)
        return null
      }
      // A refusal for this resource rotates nothing (ADR §5): the grant stays.
      this.log('info', 'oauth_resource_refused', { resource: uri, status: response.status, code })
      if (response.status >= 500) this.markStale(true)
      return null
    }
    const tokens = oauthTokenResponseSchema.safeParse(await response.json().catch(() => null))
    if (!tokens.success) {
      this.log('warn', 'oauth_refresh_malformed', { resource: uri })
      return null
    }
    // Save the rotated refresh token before the access token is used: the old one is spent.
    if (tokens.data.refresh_token && this.grant?.refreshToken === grant.refreshToken) {
      this.grant = { ...this.grant, refreshToken: tokens.data.refresh_token }
      this.saveStore(this.grant)
    }
    const expiresAt = this.deps.now() + (tokens.data.expires_in ?? 300) * 1000
    this.cache.set(uri, { token: tokens.data.access_token, expiresAt })
    this.markStale(false)
    return this.isEnding ? null : tokens.data.access_token
  }

  private async adopt(tokens: OAuthTokenResponse, discovery: Discovery, nonce: string | null): Promise<SignInEnd> {
    if (!tokens.refresh_token || !tokens.id_token) return this.failSignIn('error', 'tokens_incomplete')
    const identity = this.identityOf(tokens.id_token, discovery, nonce)
    if (!identity) return this.failSignIn('error', 'id_token_invalid')
    const grant: StoredGrant = {
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      identity,
      signedInAt: this.deps.now(),
    }
    try {
      this.deps.store.save(grant)
    } catch (error) {
      this.log('warn', 'oauth_store_failed', { reason: String(error) })
      return this.failSignIn('error', 'store_failed')
    }
    this.grant = grant
    this.cache.clear()
    this.setState(this.signedIn(grant, false))
    this.log('info', 'oauth_sign_in_ended', { end: 'approved' })
    return 'approved'
  }

  /**
   * The identity of an ID token. The token comes straight from the token endpoint
   * over TLS, so the issuer is checked by TLS and not by the signature (OIDC Core
   * §3.1.3.7, rule 6); its claims are still checked: issuer, audience, nonce, expiry.
   */
  private identityOf(idToken: string, discovery: Discovery, nonce: string | null): AccountIdentity | null {
    const claims = decodeJwtClaims(idToken, idTokenSchema)
    if (!claims) return null
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== discovery.issuer) return null
    if (!audiences.includes(this.deps.clientId)) return null
    if (claims.exp * 1000 <= this.deps.now()) return null
    if (nonce !== null && claims.nonce !== nonce) return null
    return decodeJwtClaims(idToken, identityClaimsSchema)
  }

  private endGrant(grant: StoredGrant): void {
    if (this.grant?.refreshToken !== grant.refreshToken) return
    this.grant = null
    this.cache.clear()
    this.clearStore()
    this.setState({ kind: 'invalid', reason: 'revoked' })
  }

  private failSignIn(end: SignInEnd, reason: string): SignInEnd {
    this.log('info', 'oauth_sign_in_ended', { end, reason })
    this.restoreAfterSignIn()
    return end
  }

  /** After a sign-in that did not finish: the grant held before it, or none. */
  private restoreAfterSignIn(): void {
    this.setState(this.grant ? this.signedIn(this.grant, false) : { kind: 'signed-out' })
  }

  private markStale(isStale: boolean): void {
    if (this.current.kind !== 'signed-in' || this.current.isStale === isStale || !this.grant) return
    this.setState(this.signedIn(this.grant, isStale))
  }

  private signedIn(grant: StoredGrant, isStale: boolean): AccountState {
    return { kind: 'signed-in', identity: grant.identity, consoleUrl: this.deps.cloudOrigin, signedInAt: grant.signedInAt, isStale }
  }

  private setState(state: AccountState): void {
    this.current = state
    for (const listener of this.listeners) listener(state)
  }

  private saveStore(grant: StoredGrant): void {
    try {
      this.deps.store.save(grant)
    } catch (error) {
      // The new token stays in memory: the old one is spent either way.
      this.log('warn', 'oauth_store_failed', { reason: String(error) })
    }
  }

  private clearStore(): void {
    try {
      this.deps.store.clear()
    } catch (error) {
      this.log('warn', 'oauth_store_clear_failed', { reason: String(error) })
    }
  }

  /** The provider's metadata (OIDC Discovery), read once; a failed read is tried again next time. */
  private discovery(): Promise<Discovery> {
    if (!this.discoveryRead) {
      const read = (async () => {
        const response = await this.deps.fetch(`${this.deps.cloudOrigin}/.well-known/openid-configuration`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`discovery_failed_${response.status}`)
        const discovery = discoverySchema.parse(await response.json())
        // OIDC Discovery §4.3: the issuer is the origin the metadata was read from.
        if (discovery.issuer.replace(/\/$/, '') !== this.deps.cloudOrigin) throw new Error('discovery_issuer_mismatch')
        return discovery
      })()
      this.discoveryRead = read
      read.catch(() => {
        if (this.discoveryRead === read) this.discoveryRead = null
      })
    }
    return this.discoveryRead
  }

  private post(url: string, form: { [name: string]: string }): Promise<Response> {
    return this.deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  private randomToken(): string {
    const bytes = this.deps.randomBytes ? this.deps.randomBytes(32) : globalThis.crypto.getRandomValues(new Uint8Array(32))
    return base64Url(bytes)
  }

  private async sha256(data: Uint8Array): Promise<Uint8Array> {
    if (this.deps.sha256) return this.deps.sha256(data)
    // SAFETY: a fresh `Uint8Array` from TextEncoder is backed by an ArrayBuffer.
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
  }

  private log(level: 'info' | 'warn', event: string, data?: { [key: string]: string | number | boolean | null }): void {
    this.deps.log?.[level](event, data)
  }
}

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The payload of a JWT read with `schema`, unverified; null when it is not one or does not match. */
export function decodeJwtClaims<T>(token: string, schema: z.ZodType<T>): T | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function errorCodeOf(response: Response): Promise<string> {
  const parsed = tokenErrorSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.error : `http_${response.status}`
}
