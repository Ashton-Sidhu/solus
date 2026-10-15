import { afterAll, describe, expect, test } from 'bun:test'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import type { AccountVaultResult } from '@solus/contracts/host-api'
import type { VaultConnection } from '@solus/contracts/vault'
import { SvelteRunes } from './helpers/svelte-runes'
import {
  accountConnectionText,
  cloudConnectionsPointerUrl,
  typeSafeAccountStatus,
} from '@solus/workspace-ui/components/seats/lib/cloud-connections'

// The store runs on Svelte's real client runtime, as in the app.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const { accountVaultStore: store }: typeof import('@solus/workspace-ui/components/seats/account-vault.store.svelte') = await import(
  runes.source('account-vault', 'packages/workspace-ui/src/components/seats/account-vault.store.svelte.ts', {
    './lib/cloud-connections': SvelteRunes.file('packages/workspace-ui/src/components/seats/lib/cloud-connections.ts'),
  })
)

// docs/plans/cloud-vault.md §2.5, "Signed in means the account": a signed-in
// person's GitHub, Google, Atlassian, and TypeSafe credentials are in their
// Solus account, the linked owner's too. Settings shows the account's status
// and the way to the account, and never claims a status it did not read. Only
// the owner of a host that is not linked keeps the host's own controls.

const github = (status: VaultConnection['status'], label: string | null): VaultConnection =>
  ({ ref: { kind: 'provider', provider: 'github' }, material: 'oauth', status, label, updatedAt: 1 })

/** A fake account whose answers the test releases one at a time. */
function account() {
  const pending: Array<(result: AccountVaultResult) => void> = []
  const requests = {
    accountVault: () => new Promise<AccountVaultResult>((resolve) => pending.push(resolve)),
  }
  // SAFETY: the store calls only `accountVault`.
  store.usePort({ requests: () => requests as unknown as AgentProfileCloudRequests })
  return {
    reads: () => pending.length,
    answer: async (result: AccountVaultResult, index = pending.length - 1) => {
      pending[index]!(result)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

describe('the account status in Settings', () => {
  test('a signed-in person sees each provider as their account reports it, with its account name', async () => {
    const cloud = account()
    void store.load()
    // Until the account answers, the row says it is reading, not "Not connected".
    expect(accountConnectionText(store.providerStatus('github'))).toBe('Reading your Solus account…')
    await cloud.answer({ kind: 'ok', connections: [github('connected', 'ada'), { ...github('needs-sign-in', null), ref: { kind: 'provider', provider: 'google' } }] })
    expect(accountConnectionText(store.providerStatus('github'))).toBe('Connected in your Solus account as ada')
    expect(accountConnectionText(store.providerStatus('google'))).toBe('Needs sign-in on your Solus account')
    expect(accountConnectionText(store.providerStatus('atlassian'))).toBe('Not connected')
  })

  test('a read again keeps the last answer, and an older answer does not land over a newer one', async () => {
    const cloud = account()
    void store.load()
    await cloud.answer({ kind: 'ok', connections: [] })
    void store.load()
    void store.load()
    expect(store.providerStatus('github')).toEqual({ kind: 'not-connected' })
    await cloud.answer({ kind: 'ok', connections: [github('connected', 'new')] })
    await cloud.answer({ kind: 'ok', connections: [] }, cloud.reads() - 2)
    expect(store.providerStatus('github')).toEqual({ kind: 'connected', label: 'new' })
  })

  test('an account that does not answer says why, not a status', async () => {
    const cloud = account()
    void store.load()
    await cloud.answer({ kind: 'signed-out' })
    expect(accountConnectionText(store.providerStatus('github'))).toBe('Sign in to Solus again to see your connections.')
    void store.load()
    await cloud.answer({ kind: 'offline' })
    expect(store.providerStatus('github')?.kind).toBe('failed')
  })

  test('with no account to read there is no status, only where to connect', async () => {
    store.usePort({ requests: () => null })
    await store.load()
    expect(store.providerStatus('github')).toBeNull()
    expect(accountConnectionText(null)).toBe('Connect it on your Solus account.')
  })

  test('people connect on the website, so a watched list reads again when the window gets focus', async () => {
    const cloud = account()
    const target = new EventTarget()
    Object.assign(globalThis, { window: target })
    try {
      const stop = store.watch()
      const before = cloud.reads()
      target.dispatchEvent(new Event('focus'))
      expect(cloud.reads()).toBe(before + 1)
      stop()
      target.dispatchEvent(new Event('focus'))
      expect(cloud.reads()).toBe(before + 1)
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })

  test('TypeSafe in the account: a saved key reads as connected there, else not connected', () => {
    expect(accountConnectionText(typeSafeAccountStatus('saved'))).toBe('Connected in your Solus account')
    expect(accountConnectionText(typeSafeAccountStatus(null))).toBe('Not connected')
  })
})

describe('which rows point to the account', () => {
  test('the host names the account page for a signed-in person, the linked owner included', () => {
    const accountConnectionsUrl = 'https://app.solus.sh/connections'
    for (const principal of ['local-owner', 'remote-owner', 'org-member'] as const) {
      expect(cloudConnectionsPointerUrl({ identity: { principal, userId: 'ada', user: null, accountConnectionsUrl }, directoryUrl: undefined })).toBe(accountConnectionsUrl)
    }
  })

  test('the owner of a host that is not linked keeps the host controls', () => {
    expect(cloudConnectionsPointerUrl({ identity: { principal: 'local-owner', userId: null, user: null }, directoryUrl: 'https://app.solus.sh/' })).toBeNull()
  })
})
