import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { SecretStore } from '@solus/server/platform/secrets'
import type { VaultTransport } from '@solus/server/vault/vault-client'
import type { RunnerGrantInfo } from '@solus/server/server/uplink/runner-delivery'

// The dispatch-checkout layout module reaches the database; this Bun has no
// `node:sqlite`. The real module is loaded so the mock below can keep every
// export but the one this test scripts.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const dispatchCheckouts = await import('@solus/server/project-config/dispatch-checkouts')
const exec = await import('@solus/server/git/exec')

// docs/plans/cloud-service-model.md §22: on a runner in an organization, a
// member's GitHub request leads with the token they connected on the workspace
// service — leased from the vault — not with the host's own connection.

const records = new Map<string, unknown>()
const store: SecretStore = {
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => true,
}
mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))
mock.module('@solus/server/providers/github/delegation-store', () => ({
  loadDelegation: () => null,
  saveDelegation: () => {},
  clearDelegation: () => {},
}))
mock.module('@solus/server/project-config/dispatch-checkouts', () => ({ ...dispatchCheckouts, dispatchCheckoutDeviceId: () => null }))
// `gh` is signed out here; every other command runs for real.
mock.module('@solus/server/git/exec', () => ({
  ...exec,
  runAsync: async (bin: string, args: string[], cwd: string, opts?: Parameters<typeof exec.runAsync>[3]) => {
    if (bin !== 'gh') return exec.runAsync(bin, args, cwd, opts)
    throw new Error('gh: not logged in to any hosts')
  },
}))

class FakeService implements VaultTransport {
  rows = new Map<string, { version: number; method: 'login'; material: { files: Record<string, string> }; expiresAt: null }>()
  currentGrant(): RunnerGrantInfo | null { return { hostId: 'runner-1', organizationId: 'org1', workspaceUrl: 'https://ws', ownerUserId: null } }
  onGrant(): () => void { return () => {} }
  async call<T>(_path: string, body: unknown, schema: z.ZodType<T>): ReturnType<VaultTransport['call']> {
    const { userId, provider } = z.object({ userId: z.string(), provider: z.string() }).parse(body)
    const row = this.rows.get(`${userId}/${provider}`)
    return row ? { kind: 'ok', body: schema.parse(row) } : { kind: 'refused', status: 404, error: 'no_credential' }
  }
}

const { githubCredentialChain } = await import('@solus/server/providers/github/credentials')
const { resetProviderCredentialsForTests, useProviderVault } = await import('@solus/server/vault/provider-credentials')
const { VaultClient } = await import('@solus/server/vault/vault-client')
const { withCredentialScope } = await import('@solus/server/vault/credential-scope')

beforeEach(() => {
  records.clear()
  resetProviderCredentialsForTests()
})

describe('which credential a member request on a runner uses', () => {
  test("a member's chain starts with their leased token; the host owner's with the host's own", async () => {
    records.set('github-oauth', { accessToken: 'host-token', scope: 'repo' })
    const service = new FakeService()
    service.rows.set('alice/github', { version: 1, method: 'login', material: { files: { 'credential.json': JSON.stringify({ accessToken: 'alice-token', scope: 'repo' }) } }, expiresAt: null })
    useProviderVault(new VaultClient(service))

    expect(await withCredentialScope('alice', () => githubCredentialChain('leased.example'))).toEqual([{ source: 'host', token: 'alice-token' }])
    expect(await githubCredentialChain('leased.example')).toEqual([{ source: 'host', token: 'host-token' }])
    // A member with no connection of their own gets nothing of the host's: their chain is empty.
    expect(await withCredentialScope('bob', () => githubCredentialChain('leased.example'))).toEqual([])
  })
})
