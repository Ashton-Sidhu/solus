import { localApi } from '@solus/client-core/local-api'
import { cloudAccount } from '@solus/client-core/cloud-account'
import type { AccountState, SignInEnd } from '@solus/contracts/account-types'
import { askBeforeDiscardingUnsent } from '../works/work-live-discard'

/**
 * Mirrors the account state the client shell owns. On desktop the main process holds
 * the sign-in and pushes every change here. On web there is no shell capability, so
 * `isAvailable` is false; but a web client served by the account origin holds its own
 * sign-in (`web-sign-in.ts`), and the store follows that one so surfaces show who is
 * signed in and can sign out. This store carries no UI of its own: surfaces
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
      const session = cloudAccount()?.session
      if (session) {
        this.state = session.state()
        session.onChange((state) => { this.state = state })
      }
      this.hasAnswered = true
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

  /** Runs the browser sign-in; resolves with how it ended. Null when unavailable or already running. */
  async signIn(): Promise<SignInEnd | null> {
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

  /** On web, sign-out ends this page's grant and the website's cookie session; the page
   *  then boots again as signed out. Edits only this device holds are not deleted without asking. */
  async signOut(options: { discardUnsent?: boolean } = {}): Promise<void> {
    if (!options.discardUnsent && askBeforeDiscardingUnsent(undefined, () => void this.signOut({ discardUnsent: true }))) return
    if (this.isAvailable) return localApi.accountSignOut()
    const account = cloudAccount()
    if (!account) return
    await account.signOut()
    location.reload()
  }

  async retryVerify(): Promise<void> {
    if (!this.isAvailable) return
    await localApi.accountRetryVerify()
  }
}

export const accountStore = new AccountStore()
