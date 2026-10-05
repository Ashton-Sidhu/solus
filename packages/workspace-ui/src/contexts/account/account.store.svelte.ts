import { localApi } from '@solus/client-core/local-api'
import { cloudAccount } from '@solus/client-core/cloud-account'
import type { AccountState, DeviceSignInEnd } from '@solus/contracts/account-types'
import { askBeforeDiscardingUnsent } from '../works/work-live-discard'

/**
 * Mirrors the account state the client shell owns. On desktop the main process holds
 * the session and pushes every change here. On web there is no shell capability, so
 * `isAvailable` is false; but a web client served by the account origin is signed in
 * through the account cookie, and the store reads that profile once so surfaces show
 * who is signed in and can sign out. This store carries no UI of its own: surfaces
 * that render account state read it and call its commands, and decide their own feedback.
 */
class AccountStore {
  state = $state<AccountState>({ kind: 'signed-out' })
  /** False until the shell or the account origin first answers; until then `signed-out` is only the starting value. */
  hasAnswered = $state(false)
  /** True when the client shell can hold a Solus account (desktop today). */
  readonly isAvailable = localApi.accountState !== undefined
  private hasStarted = false
  private isSigningIn = false

  /** Subscribes once; safe to call from every surface that renders account state. */
  start(): void {
    if (this.hasStarted) return
    this.hasStarted = true
    if (!this.isAvailable) {
      void this.readCloudProfile().finally(() => { this.hasAnswered = true })
      return
    }
    localApi.onAccountStateChange((state) => {
      this.state = state
      this.hasAnswered = true
    })
    void localApi.accountState().then((state) => {
      this.state = state
      this.hasAnswered = true
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

  /** On web the cookie is the session: after sign-out the page boots again as signed out.
   *  Edits only this device holds are not deleted without asking. */
  async signOut(options: { discardUnsent?: boolean } = {}): Promise<void> {
    if (!options.discardUnsent && askBeforeDiscardingUnsent(undefined, () => void this.signOut({ discardUnsent: true }))) return
    if (this.isAvailable) return localApi.accountSignOut()
    const account = cloudAccount()
    if (!account) return
    await account.signOut()
    location.reload()
  }

  private async readCloudProfile(): Promise<void> {
    const account = cloudAccount()
    const profile = account ? await account.readProfile() : null
    if (!account || !profile) return
    const now = Date.now()
    this.state = {
      kind: 'signed-in',
      profile,
      consoleUrl: account.consoleUrl,
      signedInAt: now,
      lastVerifiedAt: now,
      isStale: false,
    }
  }

  async retryVerify(): Promise<void> {
    if (!this.isAvailable) return
    await localApi.accountRetryVerify()
  }
}

export const accountStore = new AccountStore()
