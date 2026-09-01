import { localApi } from '@solus/client-core/local-api'
import type { AccountState, DeviceSignInEnd } from '@solus/contracts/account-types'

/**
 * Mirrors the account state the client shell owns. On desktop the main process holds
 * the session and pushes every change here; on web there is no shell capability yet,
 * so `isAvailable` is false. This store carries no UI of its own: surfaces that render
 * account state read it and call its commands, and decide their own feedback.
 */
class AccountStore {
  state = $state<AccountState>({ kind: 'signed-out' })
  /** True when the client shell can hold a Solus account (desktop today). */
  readonly isAvailable = localApi.accountState !== undefined
  private hasStarted = false
  private isSigningIn = false

  /** Subscribes once; safe to call from every surface that renders account state. */
  start(): void {
    if (this.hasStarted || !this.isAvailable) return
    this.hasStarted = true
    localApi.onAccountStateChange((state) => {
      this.state = state
    })
    void localApi.accountState().then((state) => {
      this.state = state
    })
  }

  get isSignedIn(): boolean {
    return this.state.kind === 'signed-in'
  }

  /** Runs the device flow; resolves with how it ended. Null when unavailable or already running. */
  async signIn(): Promise<DeviceSignInEnd | null> {
    if (!this.isAvailable || this.isSigningIn) return null
    this.isSigningIn = true
    try {
      return await localApi.accountSignIn()
    } finally {
      this.isSigningIn = false
    }
  }

  cancelSignIn(): void {
    if (this.isAvailable) localApi.accountCancelSignIn()
  }

  async signOut(): Promise<void> {
    if (!this.isAvailable) return
    await localApi.accountSignOut()
  }

  async retryVerify(): Promise<void> {
    if (!this.isAvailable) return
    await localApi.accountRetryVerify()
  }
}

export const accountStore = new AccountStore()
