import { afterEach, describe, expect, test } from 'bun:test'
import type { GithubCredentialSource } from '@solus/server/providers/github/credentials'
import { useHostUser } from '@solus/server/host/host-user'
import { withUserScope } from '@solus/server/vault/acting-scope'
import { installTestIdentities } from './helpers/acting-identities'
import { fakeGithubCredentials, type FakeGithubSources } from './helpers/github-credentials'

/**
 * Which GitHub credentials each kind of person may act with (docs/plans/access-model.md §2.6,
 * `GitHubCredentials.sourcesFor`). The machine's `gh` and its paired devices are the
 * runtime logins of this machine, so only the host's own work and the machine owner
 * use them; anyone else has their own account alone.
 */

installTestIdentities()
afterEach(() => useHostUser(null))

const CHECKOUT = '/checkouts/device-1/app'

/** Every source answers: the chain shows which ones the person may use. */
const EVERY_SOURCE: FakeGithubSources = {
  hostToken: 'host-token',
  account: (accountId) => Response.json({ accessToken: `${accountId}-account`, scope: 'repo', login: accountId }),
  gh: new Map([['github.com', 'gh-token']]),
  delegations: new Map([['device-1', { accessToken: 'device-token', login: 'device' }]]),
  checkoutOwner: 'device-1',
}

interface Person {
  name: string
  /** The host's user, as host settings name it. */
  hostUser: { localId: string; account?: { accountId: string } } | null
  personKey: string | null
  every: GithubCredentialSource[]
}

const PEOPLE: Person[] = [
  { name: 'the host\'s own work', hostUser: null, personKey: null, every: ['delegated', 'host', 'gh-cli'] },
  { name: 'the machine owner, signed out', hostUser: { localId: 'mac' }, personKey: 'local:mac', every: ['delegated', 'host', 'gh-cli'] },
  { name: 'the machine owner, signed in', hostUser: { localId: 'mac', account: { accountId: 'alice' } }, personKey: 'alice', every: ['delegated', 'account', 'gh-cli'] },
  { name: 'a member', hostUser: { localId: 'mac', account: { accountId: 'alice' } }, personKey: 'bob', every: ['account'] },
  { name: 'a guest', hostUser: { localId: 'mac', account: { accountId: 'alice' } }, personKey: 'guest:visitor', every: [] },
]

describe('the GitHub credential sources of each person', () => {
  for (const person of PEOPLE) {
    test(`${person.name}: every source answers`, async () => {
      useHostUser(person.hostUser)
      const { credentials } = fakeGithubCredentials(EVERY_SOURCE)
      const chain = await withUserScope(person.personKey, () => credentials.chain('github.com', CHECKOUT))
      expect(chain.map((credential) => credential.source)).toEqual(person.every)
    })

    test(`${person.name}: no source answers`, async () => {
      useHostUser(person.hostUser)
      const { credentials } = fakeGithubCredentials()
      expect(await withUserScope(person.personKey, () => credentials.chain('github.com', CHECKOUT))).toEqual([])
    })
  }
})

describe('the GitHub chain of a signed-in person', () => {
  test('the machine owner gets their account, then their machine\'s gh', async () => {
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    const { credentials } = fakeGithubCredentials({ ...EVERY_SOURCE, checkoutOwner: null })
    expect(await withUserScope('alice', () => credentials.chain('github.com'))).toEqual([
      { source: 'account', token: 'alice-account' },
      { source: 'gh-cli', token: 'gh-token' },
    ])
  })

  test('when the account does not answer, the machine owner still has gh', async () => {
    // WHY: an account that is down or not deployed must not take the owner's pull requests away.
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    const { credentials } = fakeGithubCredentials({ ...EVERY_SOURCE, checkoutOwner: null, account: () => new Response('unavailable', { status: 503 }) })
    expect(await withUserScope('alice', () => credentials.chain('github.com'))).toEqual([
      { source: 'gh-cli', token: 'gh-token' },
    ])
  })

  test('a member with no delegation here is told to reconnect, not given an empty chain', async () => {
    // WHY: an empty chain reads as "GitHub is not connected"; the member must learn what to fix.
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    const { credentials } = fakeGithubCredentials({
      ...EVERY_SOURCE,
      account: () => ({ refused: 'NO_DELEGATION', message: 'Reconnect to your host to authorize your account connections.' }),
    })
    await expect(withUserScope('bob', () => credentials.chain('github.com'))).rejects.toThrow('Reconnect')
  })

  test('a member never gets the owner\'s gh or the paired devices', async () => {
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    const { credentials, ghCalls } = fakeGithubCredentials(EVERY_SOURCE)
    expect(await withUserScope('bob', () => credentials.chain('github.com', CHECKOUT))).toEqual([
      { source: 'account', token: 'bob-account' },
    ])
    expect(await withUserScope('bob', () => credentials.chain('enterprise.example', CHECKOUT))).toEqual([])
    expect(ghCalls).toEqual([])
  })
})
