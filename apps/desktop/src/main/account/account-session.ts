import type { AccountState, SignInEnd } from '@solus/contracts/account-types'
import { SOLUS_CLIENT_IDS, type TokenResource } from '@solus/contracts/auth/clients'
import { OAuthSession, type BrowserAuthorizer } from '@solus/client-core/oauth-session'
import { SOLUS_PROTOCOL, SOLUS_PROTOCOL_HEADER } from '@solus/contracts/uplink'
import { createLogger } from '@solus/server/logger'
import type { AccountStore } from './account-store'

const log = createLogger('main', 'account-session')

/** How often a focused window re-checks the sign-in with the website. */
export const VERIFY_INTERVAL_MS = 10 * 60_000

export interface AccountSessionDeps {
  cloudOrigin: string
  store: AccountStore
  /** The loopback browser step (`loopback-authorizer.ts`). */
  authorizer: BrowserAuthorizer
  fetch: typeof fetch
  now: () => number
  onStateChange: (state: AccountState) => void
}

/**
 * The desktop's account sign-in (docs/adr/0001-standard-authentication.md §3.3): a
 * thin wrapper of `OAuthSession` that adds what only the desktop has — the keychain
 * that can be unavailable, and calls to the website on the account's behalf. The
 * refresh token never leaves main; an access token leaves only as an
 * `Authorization` header, or to the renderer for one host or the Solus API.
 */
export class AccountSession {
  private readonly oauth: OAuthSession
  /** The keychain could not be read at start; `reloadFromDisk` asks again. */
  private isEncryptionUnavailable: boolean
  private lastVerifyAttemptAt = 0
  private readonly listeners = new Set<(state: AccountState) => void>()

  constructor(private readonly deps: AccountSessionDeps) {
    this.isEncryptionUnavailable = !deps.store.canPersist()
    this.oauth = new OAuthSession({
      cloudOrigin: deps.cloudOrigin,
      clientId: SOLUS_CLIENT_IDS.desktop,
      store: deps.store,
      authorizer: deps.authorizer,
      fetch: deps.fetch,
      now: deps.now,
      log: { info: (event, data) => log.info(event, data ?? {}), warn: (event, data) => log.warn(event, data ?? {}) },
    })
    this.oauth.onChange(() => this.announce())
    // The one line that says why every later cloud call will or will not carry a token.
    log.info('account_boot_state', { kind: this.current().kind, canPersist: !this.isEncryptionUnavailable })
  }

  current(): AccountState {
    return this.isEncryptionUnavailable ? { kind: 'unavailable', reason: 'encryption' } : this.oauth.state()
  }

  /**
   * Re-reads the stored grant. The constructor runs before Electron's `app` is
   * ready, and the keychain behind `safeStorage` is not reliably available until
   * then — a boot that raced it must not present as signed out, or as
   * keychain-unavailable, for its whole life.
   */
  reloadFromDisk(): void {
    if (!this.deps.store.canPersist()) return
    const wasUnavailable = this.isEncryptionUnavailable
    this.isEncryptionUnavailable = false
    const before = this.oauth.state().kind
    this.oauth.reload()
    if (this.oauth.state().kind !== before) log.info('account_reloaded_after_ready')
    // The keychain answered this time: an 'unavailable' verdict from the race is stale.
    else if (wasUnavailable) this.announce()
  }

  /** Every change of `current()`, for main's own readers; the renderer hears of it through `onStateChange`. */
  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private announce(): void {
    const state = this.current()
    this.deps.onStateChange(state)
    for (const listener of this.listeners) listener(state)
  }

  get cloudOrigin(): string {
    return this.deps.cloudOrigin
  }

  /** Whether a sign-in is held. A null `cloudRequest` then means the website did not answer. */
  get isSignedIn(): boolean {
    return this.current().kind === 'signed-in'
  }

  /** An access token for one resource (`OAuthSession.accessToken`); shared by every desktop window and the local host. */
  accessToken(resource: TokenResource, options?: { refused?: string }): Promise<string | null> {
    return this.oauth.accessToken(resource, options)
  }

  /**
   * A request to the website's `/v1` on the account's behalf (directory, tickets,
   * settings), with an access token for the account plane. Null when signed out or
   * the website did not answer. The token is added here and nowhere else.
   */
  async cloudRequest(path: string, init: RequestInit = {}): Promise<Response | null> {
    const token = await this.oauth.accessToken({ kind: 'account' })
    if (!token) {
      log.info('cloud_request_skipped_no_token', { path, state: this.current().kind })
      return null
    }
    try {
      return await this.deps.fetch(`${this.deps.cloudOrigin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', [SOLUS_PROTOCOL_HEADER]: String(SOLUS_PROTOCOL), ...init.headers },
      })
    } catch (error) {
      log.warn('cloud_request_failed', { path, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** The browser sign-in; refused while the keychain cannot keep its result. */
  async signIn(): Promise<SignInEnd> {
    if (!this.deps.store.canPersist()) {
      this.isEncryptionUnavailable = true
      this.announce()
      throw new Error('Sign-in needs secure system storage. Install or unlock your desktop keyring, then try again.')
    }
    this.reloadFromDisk()
    return this.oauth.signIn()
  }

  cancelSignIn(): void {
    this.oauth.cancelSignIn()
  }

  /** Revokes this install's client grant, then forgets it, even if the website is down. */
  signOut(): Promise<void> {
    return this.oauth.signOut()
  }

  /**
   * Confirms the sign-in with the website and reads the identity again. A revoked
   * grant ends the sign-in; a website that does not answer keeps it and marks it stale.
   */
  async verify(reason: 'boot' | 'focus' | 'retry'): Promise<void> {
    if (!this.isSignedIn) return
    const now = this.deps.now()
    if (reason === 'focus' && now - this.lastVerifyAttemptAt < VERIFY_INTERVAL_MS) return
    this.lastVerifyAttemptAt = now
    await this.oauth.refreshIdentity()
  }
}
