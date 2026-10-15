import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '@solus/server/platform/secrets'

/**
 * The GitHub credential chain of a person who is signed in (docs/plans/access-model.md §2.6):
 * the owner of this machine keeps their machine's own `gh` login behind their account,
 * because `gh` is a runtime login of the machine; anyone else has their account alone.
 */

const temp = mkdtempSync(join(tmpdir(), 'solus-github-owner-chain-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = temp
const values = new Map<string, string>()
const secrets: SecretStore = {
  canSave: () => true,
  loadJson: (key, _path, schema) => { const value = values.get(key); return value ? schema.parse(JSON.parse(value)) : null },
  saveJson: (key, _path, value) => { values.set(key, JSON.stringify(value)) },
  remove: (key) => { values.delete(key) },
}
mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => secrets }))
// The machine's `gh` is never the real one in a test: it answers this token.
const ghCalls: string[][] = []
mock.module('@solus/server/git/exec', () => ({
  runAsync: async (bin: string, args: string[]) => {
    if (bin !== 'gh') throw new Error(`unexpected ${bin}`)
    ghCalls.push(args)
    return 'machine-gh-token'
  },
}))

const { withUserScope } = await import('@solus/server/vault/acting-scope')
const { installTestIdentities } = await import('./helpers/acting-identities')
installTestIdentities()
const { useHostUser } = await import('@solus/server/host/host-user')
const { AccountReads, useAccountReads } = await import('@solus/server/vault/account-reads')
const { githubCredentialChain } = await import('@solus/server/providers/github/credentials')
type DelegationScope = import('@solus/server/sync/delegations').DelegationScope

/** The account plane, answering every read with `respond`, for a host acting for alice and bob. */
function account(respond: () => Response): void {
  useAccountReads(new AccountReads({
    origin: () => 'https://account.test',
    delegations: () => ({
      holders: () => ['alice', 'bob'].map((userId): { userId: string; scope: DelegationScope } => ({ userId, scope: 'personal' })),
      accessToken: async (userId) => `delegated-${userId}`,
    }),
    fetchImpl: async () => respond(),
  }))
}

afterEach(() => { useAccountReads(null); useHostUser(null); values.clear(); ghCalls.length = 0 })
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(temp, { recursive: true, force: true })
})

describe('the GitHub chain of a signed-in person', () => {
  test('the machine owner gets their account, then their machine\'s gh', async () => {
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    account(() => Response.json({ accessToken: 'alice-account', scope: 'repo', login: 'alice' }))
    expect(await withUserScope('alice', () => githubCredentialChain('github.com'))).toEqual([
      { source: 'account', token: 'alice-account' },
      { source: 'gh-cli', token: 'machine-gh-token' },
    ])
  })

  test('when the account does not answer, the machine owner still has gh', async () => {
    // WHY: an account that is down or not deployed must not take the owner's pull requests away.
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    account(() => new Response('unavailable', { status: 503 }))
    expect(await withUserScope('alice', () => githubCredentialChain('github.com'))).toEqual([
      { source: 'gh-cli', token: 'machine-gh-token' },
    ])
  })

  test('a member never gets the owner\'s gh', async () => {
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    account(() => Response.json({ accessToken: 'bob-account', scope: 'repo', login: 'bob' }))
    expect(await withUserScope('bob', () => githubCredentialChain('github.com'))).toEqual([
      { source: 'account', token: 'bob-account' },
    ])
    expect(ghCalls).toEqual([])
  })
})
