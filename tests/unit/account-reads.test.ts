import { describe, expect, test } from 'bun:test'
import { ACCOUNT_AUDIENCE, SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import { VAULT_PATH } from '@solus/contracts/vault'
import { AGENT_PROFILE_PATH } from '@solus/contracts/agent-profile'
import { DelegationError, type DelegationScope } from '@solus/server/sync/delegations'
import { AccountReads, PresentedTokens } from '@solus/server/vault/account-reads'

// docs/adr/0001-standard-authentication.md §2.2 rule 7, §3.4: every read of a person's
// account carries one token as `Authorization: Bearer`, and nothing else: a host's
// delegated token for the person, or, in the Solus API, the person's own token for our
// servers (docs/plans/simplify-auth-and-sync.md §3 rule 1), which reaches the account
// plane directly.

const ORIGIN = 'https://account.test'

interface Sent { url: string; method: string; authorization: string | null; body: string | null }

function reads(options: { held?: Array<{ userId: string; scope: DelegationScope }>; token?: (userId: string, scope: DelegationScope) => Promise<string>; origin?: string | null; answer?: () => Response; ownToken?: (userId: string) => string | null } = {}) {
  const sent: Sent[] = []
  const asked: Array<[string, DelegationScope]> = []
  const accountReads = new AccountReads({
    origin: () => options.origin === undefined ? ORIGIN : options.origin,
    ownToken: options.ownToken,
    delegations: () => ({
      holders: () => options.held ?? [],
      accessToken: async (userId, scope, resource) => {
        expect(resource).toEqual({ kind: 'account' })
        asked.push([userId, scope])
        return options.token ? options.token(userId, scope) : `delegated-${userId}`
      },
    }),
    fetchImpl: async (url, init) => {
      sent.push({ url: String(url), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? String(init.body) : null })
      return options.answer?.() ?? Response.json({ ok: true })
    },
  })
  return { accountReads, sent, asked }
}

describe('reading a person’s account', () => {
  test('the delegated token is the bearer and the body is only what the route reads', async () => {
    const { accountReads, sent } = reads({ held: [{ userId: 'bob', scope: { organizationId: 'org_a' } }] })
    const response = await accountReads.fetch('bob', null, VAULT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: { kind: 'mcp', serverUrl: 'https://mcp.test' } }) })
    expect(response).toBeInstanceOf(Response)
    expect(sent).toEqual([{ url: `${ORIGIN}${VAULT_PATH}`, method: 'POST', authorization: 'Bearer delegated-bob', body: '{"ref":{"kind":"mcp","serverUrl":"https://mcp.test"}}' }])
  })

  test('with no scope named, the person’s personal delegation is used first, else one of an organization; a named scope is used as named', async () => {
    const { accountReads, asked } = reads({ held: [{ userId: 'alice', scope: { organizationId: 'org_a' } }, { userId: 'alice', scope: 'personal' }, { userId: 'bob', scope: { organizationId: 'org_b' } }] })
    await accountReads.fetch('alice', null, VAULT_PATH, { method: 'POST' })
    await accountReads.fetch('bob', null, VAULT_PATH, { method: 'POST' })
    await accountReads.fetch('alice', { organizationId: 'org_a' }, AGENT_PROFILE_PATH)
    expect(asked).toEqual([['alice', 'personal'], ['bob', { organizationId: 'org_b' }], ['alice', { organizationId: 'org_a' }]])
  })

  test('nothing is sent for a person this host does not act for, on an unlinked host, or when the delegation is refused; each says why', async () => {
    const none = reads()
    expect(await none.accountReads.fetch('carol', null, VAULT_PATH)).toMatchObject({ refused: 'NO_DELEGATION', message: expect.stringContaining('Reconnect') })
    expect(none.sent).toEqual([])

    const unlinked = reads({ origin: null, held: [{ userId: 'carol', scope: 'personal' }] })
    expect(await unlinked.accountReads.fetch('carol', null, VAULT_PATH)).toMatchObject({ refused: 'NOT_LINKED' })
    expect(unlinked.sent).toEqual([])

    const signedOut = reads({ held: [{ userId: 'carol', scope: 'personal' }], token: async () => { throw new DelegationError('GRANT_REVOKED', 'The sign-in that let this machine act for you has ended. Sign in to Solus again.') } })
    expect(await signedOut.accountReads.fetch('carol', null, VAULT_PATH)).toMatchObject({ refused: 'NO_DELEGATION', message: expect.stringContaining('Sign in') })
    expect(signedOut.sent).toEqual([])

    const outage = reads({ held: [{ userId: 'carol', scope: 'personal' }], token: async () => { throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus is not reachable.') } })
    expect(await outage.accountReads.fetch('carol', null, VAULT_PATH)).toMatchObject({ refused: 'UNREACHABLE' })
  })

  test('the connections page is on the account plane this process reads', () => {
    expect(reads().accountReads.connectionsUrl()).toBe(`${ORIGIN}/connections`)
    expect(reads({ origin: null }).accountReads.connectionsUrl()).toBeNull()
  })
})

describe('the Solus API reads a person’s account with their own token', () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const tokenOf = (sub: string, exp: number) => `${part({ alg: 'ES256' })}.${part({ sub, grant_id: `grant_${sub}`, aud: [ACCOUNT_AUDIENCE, SOLUS_API_AUDIENCE], exp })}.c2ln`

  test('the token a client presented is the bearer, with no exchange and no delegation', async () => {
    // WHY: the deleted `solus-api` client exchanged this token for a delegation; its `aud` now includes the account plane, so it is the credential itself.
    let now = 1_000_000_000_000
    const presented = new PresentedTokens(() => now)
    const token = tokenOf('bob', now / 1000 + 300)
    presented.keep(token)
    const { accountReads, sent, asked } = reads({ ownToken: (userId) => presented.tokenFor(userId) })
    expect(await accountReads.fetch('bob', null, VAULT_PATH, { method: 'POST' })).toBeInstanceOf(Response)
    expect(sent).toEqual([{ url: `${ORIGIN}${VAULT_PATH}`, method: 'POST', authorization: `Bearer ${token}`, body: null }])
    expect(asked).toEqual([])

    // A later token replaces it; one about to end is not used, and with no delegation nothing is sent.
    const later = tokenOf('bob', now / 1000 + 600)
    presented.keep(later)
    presented.keep(token)
    expect(presented.tokenFor('bob')).toBe(later)
    now += 560_000
    expect(presented.tokenFor('bob')).toBeNull()
    expect(await accountReads.fetch('bob', null, VAULT_PATH)).toMatchObject({ refused: 'NO_DELEGATION' })
    expect(sent).toHaveLength(1)
  })

  test('another person’s token is never used', () => {
    const presented = new PresentedTokens(() => 0)
    presented.keep(tokenOf('bob', 600))
    expect(presented.tokenFor('carol')).toBeNull()
    presented.keep('not-a-jwt')
    expect(presented.tokenFor('not-a-jwt')).toBeNull()
  })
})
