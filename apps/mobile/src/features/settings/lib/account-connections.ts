import type { AccountVaultResult } from '@solus/contracts/host-api'
import type { VaultProvider } from '@solus/contracts/vault'

/**
 * A signed-in person's provider connection, as their Solus account reports it
 * (docs/plans/cloud-vault.md §2.5, "Signed in means the account"). The host
 * sends `accountConnectionsUrl` when the person's connections are in the
 * account: the owner of a linked host and every member. Then the phone shows
 * the account's status and opens the account's Connections page. Only the owner
 * of a host that is not linked connects on the host.
 */
export type AccountConnectionStatus =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'connected'; label: string | null }
  | { kind: 'needs-sign-in' }
  | { kind: 'not-connected' }

/** The account's status of one provider, from the account vault's answer. */
export function providerAccountStatus(result: AccountVaultResult, provider: VaultProvider): AccountConnectionStatus {
  switch (result.kind) {
    case 'signed-out': return { kind: 'failed', message: 'Sign in to Solus Cloud again to see your connections.' }
    case 'offline': return { kind: 'failed', message: 'Solus Cloud did not answer. Check your connection and try again.' }
    case 'error': return { kind: 'failed', message: `Solus Cloud refused: ${result.message ?? result.code}.` }
    case 'ok': {
      const connection = result.connections.find((entry) => entry.ref.kind === 'provider' && entry.ref.provider === provider)
      if (!connection) return { kind: 'not-connected' }
      return connection.status === 'connected' ? { kind: 'connected', label: connection.label } : { kind: 'needs-sign-in' }
    }
  }
}

/** A few words for a settings row. Null: the phone has no account to read. */
export function accountConnectionValue(status: AccountConnectionStatus | null): string {
  if (!status) return 'In your Solus account'
  switch (status.kind) {
    case 'loading': return 'Checking…'
    case 'failed': return 'Unavailable'
    case 'connected': return status.label ? `Connected as ${status.label}` : 'Connected'
    case 'needs-sign-in': return 'Needs sign-in'
    case 'not-connected': return 'Not connected'
  }
}
