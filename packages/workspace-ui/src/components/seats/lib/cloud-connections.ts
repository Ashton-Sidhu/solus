import type { TypeSafeKeyStatus } from '@solus/contracts/host-config'
import type { SettingsRequestFailure } from '@solus/contracts/host-api'
import type { VaultConnection, VaultProvider } from '@solus/contracts/vault'
import type { HostIdentity } from '../../../contexts/sharing/shares.store.svelte'

/**
 * Where a host row keeps a person's connections (docs/plans/cloud-vault.md §2.5,
 * "Signed in means the account"). A signed-in person's connections are in their
 * Solus account: the host's owner when this host is linked to them, and every
 * member. The host then sends `accountConnectionsUrl`, and the row points to
 * that page. Only the owner of a host that is not linked connects on the host.
 * Agent seats are a separate section on the selected execution host.
 */
export interface ConnectionsHomeInput {
  /** Who this client is to the host; undefined until the host has answered. */
  identity: HostIdentity | undefined
  /** The account origin the host is listed under; undefined when it has none. */
  directoryUrl: string | undefined
}

/** The cloud page to point at, or null when this row shows the host's own controls. */
export function cloudConnectionsPointerUrl({ identity, directoryUrl }: ConnectionsHomeInput): string | null {
  if (identity?.accountConnectionsUrl) return identity.accountConnectionsUrl
  if (!directoryUrl || identity?.principal !== 'org-member') return null
  return new URL('/connections', directoryUrl).toString()
}

/** One connection as the person's account reports it. */
export type AccountConnectionStatus =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'connected'; label: string | null }
  | { kind: 'needs-sign-in' }
  | { kind: 'not-connected' }

/** The account's status of one provider, from the vault's connection list. */
export function providerAccountStatus(connections: readonly VaultConnection[], provider: VaultProvider): AccountConnectionStatus {
  const connection = connections.find((entry) => entry.ref.kind === 'provider' && entry.ref.provider === provider)
  if (!connection) return { kind: 'not-connected' }
  return connection.status === 'connected' ? { kind: 'connected', label: connection.label } : { kind: 'needs-sign-in' }
}

/** The TypeSafe key as the host reads it from the account: `saved` means the account holds one. */
export function typeSafeAccountStatus(source: TypeSafeKeyStatus['source']): AccountConnectionStatus {
  return source === 'saved' ? { kind: 'connected', label: null } : { kind: 'not-connected' }
}

/** The words for an account status. Null: this client has no account to read, so it says only where to connect. */
export function accountConnectionText(status: AccountConnectionStatus | null): string {
  if (!status) return 'Connect it on your Solus account.'
  switch (status.kind) {
    case 'loading': return 'Reading your Solus account…'
    case 'failed': return status.message
    case 'connected': return status.label ? `Connected in your Solus account as ${status.label}` : 'Connected in your Solus account'
    case 'needs-sign-in': return 'Needs sign-in on your Solus account'
    case 'not-connected': return 'Not connected'
  }
}

/** The row's line: who it is connected as, what is wrong, or what connecting gives. */
export function accountConnectionDescription(status: AccountConnectionStatus | null, purpose: string | undefined): string {
  const text = accountConnectionText(status)
  if (!purpose || (status && status.kind !== 'not-connected')) return text
  return status ? `${text}. ${purpose}` : `${purpose} ${text}`
}

/** The row's one verb, named for what the account page will do. */
export function accountConnectionAction(status: AccountConnectionStatus | null): string {
  switch (status?.kind) {
    case 'connected': return 'Manage'
    case 'needs-sign-in': return 'Sign in again'
    case 'not-connected': return 'Connect'
    default: return 'Open account'
  }
}

/** The words for an account read that did not answer. */
export function accountReadFailureText(result: SettingsRequestFailure): string {
  switch (result.kind) {
    case 'signed-out': return 'Sign in to Solus again to see your connections.'
    case 'offline': return 'Solus could not reach your account. Try again when you reconnect.'
    case 'error': return result.message ?? `Solus could not read your account (${result.code}).`
  }
}
