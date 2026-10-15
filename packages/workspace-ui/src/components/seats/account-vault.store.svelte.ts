import type { VaultConnection, VaultProvider } from '@solus/contracts/vault'
import type { CloudSignInPort } from '../settings/integrations.store.svelte'
import { accountReadFailureText, providerAccountStatus, type AccountConnectionStatus } from './lib/cloud-connections'

/** The account calls this store uses: the same port the integrations store signs in through. */
export type AccountVaultPort = Pick<CloudSignInPort, 'requests'>

type AccountVaultView =
  | { kind: 'loading' }
  | { kind: 'loaded'; connections: VaultConnection[] }
  | { kind: 'failed'; message: string }

/**
 * The signed-in person's connections in their account vault
 * (docs/plans/cloud-vault.md §2.5), as the Settings rows that point to the
 * account show them. People connect on the website, so a watched list reads
 * again when the window gets focus. With no account to call, there is no
 * status: the rows show only where to connect.
 */
class AccountVaultStore {
  /** Null while this client has no account to read. */
  view = $state<AccountVaultView | null>(null)
  private port: AccountVaultPort | null = null
  /** Bumped by every read; an older answer does not land. */
  private revision = 0
  private watchers = 0
  private stopFocus: (() => void) | null = null

  /** Installed by the app core, so this store imports no account state; tests install a fake. */
  usePort(port: AccountVaultPort | null): void {
    this.port = port
  }

  /** Reads the list. A read again keeps the last answer on screen until the new one arrives. */
  async load(): Promise<void> {
    const revision = ++this.revision
    const requests = this.port?.requests() ?? null
    if (!requests) {
      this.view = null
      return
    }
    if (this.view?.kind !== 'loaded') this.view = { kind: 'loading' }
    const result = await requests.accountVault().catch((cause: unknown) => ({
      kind: 'error' as const,
      code: 'request_failed',
      message: cause instanceof Error ? cause.message : null,
    }))
    if (revision !== this.revision) return
    this.view = result.kind === 'ok'
      ? { kind: 'loaded', connections: result.connections }
      : { kind: 'failed', message: accountReadFailureText(result) }
  }

  /** Reads the list again each time the window gets focus, while a row watches. */
  watch(): () => void {
    if (this.watchers++ === 0) {
      const onFocus = () => void this.load()
      window.addEventListener('focus', onFocus)
      this.stopFocus = () => window.removeEventListener('focus', onFocus)
    }
    return () => {
      if (--this.watchers > 0) return
      this.stopFocus?.()
      this.stopFocus = null
    }
  }

  /** The account's status of one provider; null with no account to read. */
  providerStatus(provider: VaultProvider): AccountConnectionStatus | null {
    const view = this.view
    if (!view) return null
    if (view.kind === 'loaded') return providerAccountStatus(view.connections, provider)
    return view
  }
}

export const accountVaultStore = new AccountVaultStore()
