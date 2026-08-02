/**
 * The one place the renderer knows anything about the Cloudflare profile.
 *
 * The API token itself never lands here: `connect()` takes it as an argument,
 * hands it straight to main, and lets it go. What survives the call is only
 * what main is willing to report back — account name, id, and where the
 * credential came from.
 */

export interface CloudflareStatus {
  connected: boolean
  accountName?: string
  accountId?: string
  source?: 'env' | 'stored'
  expiresOn?: number
}

export interface CloudflareAccountOption {
  id: string
  name: string
}

/** Why a connect attempt stopped. Each kind has a different way out, so the
 *  forms branch on this rather than on the message. */
export type CloudflareConnectFailure =
  | { kind: 'invalid' | 'network' | 'encryption-unavailable'; message: string }
  /** The token works but cannot list accounts — the user must type an id. */
  | { kind: 'accounts-forbidden'; message: string }
  /** The token sees several accounts — the user must pick one. */
  | { kind: 'choose-account'; message: string; accounts: CloudflareAccountOption[] }

export const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens'
export const CLOUDFLARE_SIGNUP_URL = 'https://dash.cloudflare.com/sign-up'

/** Verbatim Cloudflare permission names and access levels, kept structured so
 *  the UI can mirror the rows users add in the custom-token editor. */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  { permission: 'Workers Scripts', access: 'Edit' },
  { permission: 'D1', access: 'Edit' },
  { permission: 'Workers KV Storage', access: 'Edit' },
  { permission: 'Workers R2 Storage', access: 'Edit' },
  { permission: 'Account Settings', access: 'Read' },
] as const

class CloudflareStore {
  status = $state<CloudflareStatus | null>(null)
  statusLoaded = $state(false)
  connecting = $state(false)
  failure = $state<CloudflareConnectFailure | null>(null)
  /** Raised by the `cloudflare-connect-needed` topic; what puts the card on
   *  screen. Cleared by a dismissal or by a successful connect. */
  connectRequested = $state(false)

  private statusRequest: Promise<void> | null = null

  get connected(): boolean {
    return this.status?.connected === true
  }

  /** An env-var token is the machine's, not the app's — nothing here can revoke it. */
  get isEnvManaged(): boolean {
    return this.status?.source === 'env'
  }

  get accountName(): string {
    return this.status?.accountName ?? ''
  }

  /** The request survives the connect that answers it: the card has to stay up
   *  long enough to say it worked and offer the continue. Only a dismissal
   *  retires it. */
  get connectCardVisible(): boolean {
    return this.connectRequested && !this.isEnvManaged
  }

  /** First caller pays for the fetch; everyone after reads the cached status. */
  ensureStatus(): Promise<void> {
    if (this.statusLoaded) return Promise.resolve()
    return (this.statusRequest ??= this.loadStatus())
  }

  async refreshStatus(): Promise<void> {
    this.statusRequest = this.loadStatus()
    await this.statusRequest
  }

  private async loadStatus(): Promise<void> {
    try {
      this.status = await window.solus.cloudflareStatus()
    } catch (e) {
      console.error('cloudflareStatus failed', e)
    } finally {
      this.statusLoaded = true
      this.statusRequest = null
    }
  }

  /**
   * Returns true once the profile is connected. `accountId` is the retry arm:
   * pass it after a `choose-account` or `accounts-forbidden` failure, along
   * with the same token, and the call goes through.
   */
  async connect(apiToken: string, accountId?: string): Promise<boolean> {
    if (this.connecting) return false
    this.connecting = true
    this.failure = null
    try {
      const result = await window.solus.cloudflareConnect(
        accountId ? { apiToken, accountId } : { apiToken },
      )
      if (result.ok) {
        await this.refreshStatus()
        return true
      }
      this.failure =
        result.kind === 'choose-account'
          ? {
              kind: 'choose-account',
              message: 'This token can reach more than one account. Pick the one to deploy to.',
              accounts: result.accounts,
            }
          : { kind: result.kind, message: result.error }
      return false
    } catch (e) {
      console.error('cloudflareConnect failed', e)
      this.failure = { kind: 'network', message: 'Could not reach the Cloudflare API.' }
      return false
    } finally {
      this.connecting = false
    }
  }

  async disconnect(): Promise<void> {
    try {
      await window.solus.cloudflareDisconnect()
      this.failure = null
      await this.refreshStatus()
    } catch (e) {
      console.error('cloudflareDisconnect failed', e)
    }
  }

  clearFailure(): void {
    this.failure = null
  }

  dismissConnectRequest(): void {
    this.connectRequested = false
    this.failure = null
  }

  /** Called once at boot. An agent that needs the profile raises the card even
   *  if no Cloudflare surface has ever been opened, so the status read is
   *  kicked off here rather than waiting for a component to ask. */
  listenForConnectRequests(): () => void {
    return window.solus.onCloudflareConnectNeeded(() => {
      void this.ensureStatus().then(() => {
        // Main only broadcasts on a disconnected profile, but the user may have
        // connected from Settings in the meantime — don't ask twice.
        if (!this.connected) this.connectRequested = true
      })
    })
  }
}

export const cloudflareStore = new CloudflareStore()
