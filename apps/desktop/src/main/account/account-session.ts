import type { AccountState, DeviceSignInEnd } from '@solus/contracts/account-types'
import { createLogger } from '@solus/server/logger'
import { formatUserCode } from './user-code-format'
import { AccountStore, profileFromResponse, type StoredAccount } from './account-store'
import { requestDeviceCode, waitForApproval, DEVICE_CLIENT_ID, type DeviceSignInDeps } from './device-sign-in'

const log = createLogger('main', 'account-session')

/** How often a focused window re-checks the session with the website. */
export const VERIFY_INTERVAL_MS = 10 * 60_000

export interface AccountSessionDeps extends Omit<DeviceSignInDeps, 'cloudOrigin'> {
  cloudOrigin: string
  store: AccountStore
  /** Opens the approval page in the system browser. */
  openExternal: (url: string) => Promise<void>
  /** What this machine is called in the website's device list. */
  deviceLabel: () => string
  onStateChange: (state: AccountState) => void
}

/**
 * Owns the account session for this install: sign-in through the device flow,
 * verification against the website, and sign-out. The token never leaves this
 * module except as an `Authorization` header.
 */
export class AccountSession {
  private state: AccountState
  private stored: StoredAccount | null
  private signInAbort: AbortController | null = null
  private lastVerifyAttemptAt = 0

  constructor(private readonly deps: AccountSessionDeps) {
    this.stored = deps.store.canPersist() ? deps.store.load() : null
    this.state = !deps.store.canPersist()
      ? { kind: 'unavailable', reason: 'encryption' }
      : this.stored
        ? signedInState(this.stored, false)
        : { kind: 'signed-out' }
  }

  current(): AccountState {
    return this.state
  }

  private setState(state: AccountState): void {
    this.state = state
    this.deps.onStateChange(state)
  }

  private authHeaders(): HeadersInit | null {
    return this.stored ? { authorization: `Bearer ${this.stored.sessionToken}`, accept: 'application/json' } : null
  }

  async signIn(): Promise<DeviceSignInEnd> {
    if (!this.deps.store.canPersist()) return 'error'
    if (this.signInAbort) this.signInAbort.abort()
    const abort = new AbortController()
    this.signInAbort = abort
    log.info('account_sign_in_started')

    let grant
    try {
      grant = await requestDeviceCode(this.deps)
    } catch (error) {
      log.warn('account_sign_in_ended', { end: 'error', reason: error instanceof Error ? error.message : String(error) })
      this.setState({ kind: 'invalid', reason: 'unreachable' })
      return 'error'
    }

    this.setState({
      kind: 'signing-in',
      userCode: formatUserCode(grant.userCode),
      verificationUrl: grant.verificationUrl,
      expiresAt: grant.expiresAt,
    })
    void this.deps.openExternal(grant.verificationUrl)

    const result = await waitForApproval(grant, this.deps, abort.signal)
    if (this.signInAbort === abort) this.signInAbort = null
    if (result.end !== 'approved') {
      log.info('account_sign_in_ended', { end: result.end })
      this.setState(result.end === 'cancelled' ? { kind: 'signed-out' } : { kind: 'invalid', reason: result.end === 'expired' ? 'expired' : 'unreachable' })
      if (result.end === 'denied' || result.end === 'error') this.setState({ kind: 'signed-out' })
      return result.end
    }

    const now = this.deps.now()
    const profile = await this.fetchProfile(result.sessionToken)
    if (!profile) {
      log.warn('account_sign_in_ended', { end: 'error', reason: 'profile_unavailable' })
      this.setState({ kind: 'invalid', reason: 'unreachable' })
      return 'error'
    }
    this.stored = { sessionToken: result.sessionToken, profile, cloudOrigin: this.deps.cloudOrigin, signedInAt: now, lastVerifiedAt: now }
    this.deps.store.save(this.stored)
    this.setState(signedInState(this.stored, false))
    log.info('account_sign_in_ended', { end: 'approved' })
    void this.labelDevice()
    return 'approved'
  }

  cancelSignIn(): void {
    this.signInAbort?.abort()
    this.signInAbort = null
  }

  /** Ends the session on the website and forgets it locally, even if the website is down. */
  async signOut(): Promise<void> {
    this.cancelSignIn()
    const headers = this.authHeaders()
    if (headers) {
      try {
        await this.deps.fetch(`${this.deps.cloudOrigin}/api/auth/sign-out`, { method: 'POST', headers })
      } catch {
        // The local session ends regardless; the website drops it on expiry.
      }
    }
    this.stored = null
    this.deps.store.clear()
    this.setState({ kind: 'signed-out' })
    log.info('account_signed_out')
  }

  /**
   * Confirms the stored session with the website. A 401 means the website revoked or
   * expired it; a network failure keeps the session and marks it stale.
   */
  async verify(reason: 'boot' | 'focus' | 'retry'): Promise<void> {
    if (!this.stored) return
    const now = this.deps.now()
    if (reason === 'focus' && now - this.lastVerifyAttemptAt < VERIFY_INTERVAL_MS) return
    this.lastVerifyAttemptAt = now

    let response: Response
    try {
      response = await this.deps.fetch(`${this.deps.cloudOrigin}/api/account/me`, { headers: this.authHeaders()! })
    } catch {
      this.setState(signedInState(this.stored, true))
      return
    }
    if (response.status === 401) {
      log.info('account_invalidated', { reason: 'revoked' })
      this.stored = null
      this.deps.store.clear()
      this.setState({ kind: 'invalid', reason: 'revoked' })
      return
    }
    if (!response.ok) {
      this.setState(signedInState(this.stored, true))
      return
    }
    const profile = await profileFromResponse(response)
    if (profile) this.stored = { ...this.stored, profile, lastVerifiedAt: now }
    this.deps.store.save(this.stored)
    this.setState(signedInState(this.stored, false))
    log.info('account_verified')
  }

  private async fetchProfile(sessionToken: string) {
    try {
      const response = await this.deps.fetch(`${this.deps.cloudOrigin}/api/account/me`, {
        headers: { authorization: `Bearer ${sessionToken}`, accept: 'application/json' },
      })
      if (!response.ok) return null
      return await profileFromResponse(response)
    } catch {
      return null
    }
  }

  private async labelDevice(): Promise<void> {
    const headers = this.authHeaders()
    if (!headers) return
    try {
      await this.deps.fetch(`${this.deps.cloudOrigin}/api/account/device-label`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceLabel: this.deps.deviceLabel(), clientId: DEVICE_CLIENT_ID }),
      })
    } catch {
      // Cosmetic; the session works unnamed.
    }
  }
}

function signedInState(stored: StoredAccount, isStale: boolean): AccountState {
  return {
    kind: 'signed-in',
    profile: stored.profile,
    signedInAt: stored.signedInAt,
    lastVerifiedAt: stored.lastVerifiedAt,
    isStale,
  }
}
