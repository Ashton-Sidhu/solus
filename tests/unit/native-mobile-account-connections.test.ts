import { describe, expect, test } from 'bun:test'
import type { VaultConnection } from '@solus/contracts/vault'
import { accountConnectionValue, providerAccountStatus } from '../../apps/mobile/src/features/settings/lib/account-connections'

// docs/plans/cloud-vault.md §2.5 on the phone: when the host says a signed-in
// person's GitHub connection is in their Solus account, the GitHub row shows the
// account's status, never the host's, and never a status it did not read.

const connection = (provider: 'github' | 'google', status: VaultConnection['status'], label: string | null): VaultConnection =>
  ({ ref: { kind: 'provider', provider }, material: 'oauth', status, label, updatedAt: 1 })

describe('the GitHub row of a signed-in person', () => {
  test('reads the account: connected with its account name, needs sign-in, or not connected', () => {
    const answer = { kind: 'ok' as const, connections: [connection('github', 'connected', 'ada')] }
    expect(accountConnectionValue(providerAccountStatus(answer, 'github'))).toBe('Connected as ada')
    expect(accountConnectionValue(providerAccountStatus({ kind: 'ok', connections: [connection('github', 'needs-sign-in', null)] }, 'github'))).toBe('Needs sign-in')
    // Another provider's connection is not GitHub's.
    expect(accountConnectionValue(providerAccountStatus({ kind: 'ok', connections: [connection('google', 'connected', 'ada')] }, 'github'))).toBe('Not connected')
  })

  test('an account that does not answer reads as unavailable with the reason, not as not connected', () => {
    const status = providerAccountStatus({ kind: 'signed-out' }, 'github')
    expect(status).toEqual({ kind: 'failed', message: 'Sign in to Solus Cloud again to see your connections.' })
    expect(accountConnectionValue(status)).toBe('Unavailable')
    expect(providerAccountStatus({ kind: 'error', code: 'server_error', message: null }, 'github')).toEqual({ kind: 'failed', message: 'Solus Cloud refused: server_error.' })
    expect(accountConnectionValue({ kind: 'loading' })).toBe('Checking…')
  })

  test('a phone with no account to read says where the connection is', () => {
    expect(accountConnectionValue(null)).toBe('In your Solus account')
  })
})
