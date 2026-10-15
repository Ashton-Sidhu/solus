import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { SecretStore } from '@solus/server/platform/secrets'

const temp = mkdtempSync(join(tmpdir(), 'solus-account-credentials-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = temp
const values = new Map<string, string>()
const touches: string[] = []
const secrets: SecretStore = {
  canSave: () => true,
  loadJson: (key, _path, schema) => { touches.push(key); const value = values.get(key); return value ? schema.parse(JSON.parse(value)) : null },
  saveJson: (key, _path, value) => { touches.push(key); values.set(key, JSON.stringify(value)) },
  remove: (key) => { values.delete(key) },
}
mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => secrets }))
const { withUserScope } = await import('@solus/server/vault/acting-scope')
const { installTestIdentities } = await import('./helpers/acting-identities')
// Members act from homes of their own, as on a booted server (plans/019).
installTestIdentities()
const { credentialLocationOf, vault } = await import('@solus/server/vault/vault')
const GITHUB = { kind: 'provider', provider: 'github' } as const
const GOOGLE = { kind: 'provider', provider: 'google' } as const
const { useHostUser } = await import('@solus/server/host/host-user')
const { AccountReads, useAccountReads } = await import('@solus/server/vault/account-reads')
type DelegationScope = import('@solus/server/sync/delegations').DelegationScope
const { actorFor, ownerKeyOf } = await import('@solus/server/admission/actor')
type Principal = import('@solus/server/admission/principal').Principal
/** The person `SolusServer.handle()` puts in a caller's scope (docs/plans/access-model.md §2.1). */
const credentialKeyFor = (principal: Principal): string | null => ownerKeyOf(actorFor(principal))
const { adoptProvisionedRegistration, resetHostCategoryForTests } = await import('@solus/server/host/host-category')
const { githubCredentials } = await import('@solus/server/providers/github/credentials')
const token = z.object({ accessToken: z.string() })
const localOwner = { kind: 'local-owner', deviceId: null, deviceLabel: 'This Mac' } as const
const remoteOwner = { kind: 'remote-owner', userId: 'alice', deviceId: 'device', deviceLabel: 'Web', expiresAt: Date.now() + 60_000 } as const
afterEach(() => { useAccountReads(null); values.clear(); touches.length = 0; resetHostCategoryForTests() })
afterAll(() => { if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previousDataDir; rmSync(temp, { recursive: true, force: true }) })

interface AccountCall { path: string; authorization: string | null; body: string | null }

/**
 * A host linked to the account plane that acts for the people in `delegated` (ADR 0001
 * §3.4): every account read carries that person's delegated token as the bearer.
 */
function linkAccount(respond: (path: string) => Response, delegated: string[] = ['alice']): AccountCall[] {
  const calls: AccountCall[] = []
  const held = new Set(delegated)
  useAccountReads(new AccountReads({
    origin: () => 'https://account.test',
    delegations: () => ({
      holders: () => [...held].map((userId): { userId: string; scope: DelegationScope } => ({ userId, scope: 'personal' })),
      accessToken: async (userId) => `delegated-${userId}`,
    }),
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? String(init.body) : null })
      return respond(path)
    },
  }))
  return calls
}

describe('account integration identity', () => {
  test('GitHub account requests never fall back to checkout, host, or gh credentials', async () => {
    values.set('github-oauth', JSON.stringify({ accessToken: 'wrong-host-user' }))
    let connected = true
    linkAccount(() => connected ? Response.json({ accessToken: 'alice-only', scope: 'repo', login: 'alice' }) : Response.json({}, { status: 404 }))
    expect(await withUserScope('alice', () => githubCredentials().chain('github.com', '/unrelated/checkout'))).toEqual([{ source: 'account', token: 'alice-only' }])
    connected = false
    expect(await withUserScope('alice', () => githubCredentials().chain('github.com', '/unrelated/checkout'))).toEqual([])
    expect(await withUserScope('alice', () => githubCredentials().chain('enterprise.example'))).toEqual([])
    expect(touches).toEqual([])
  })
  test('a person\'s connection is read with the host\'s delegation for them as the bearer, never a token in a body, and nobody else\'s', async () => {
    // WHY: ADR 0001 §2.2 rule 7 — work continues after every client closed, its tools
    // still act as its person, and only as that person.
    const calls = linkAccount(() => Response.json({ accessToken: 'carol-only', scope: 'repo', login: 'carol' }), [])
    // No delegation for carol: nothing is sent, and the call says so.
    await expect(withUserScope('carol', () => githubCredentials().chain('github.com'))).rejects.toThrow('Reconnect')
    expect(calls).toEqual([])
    const withCarol = linkAccount(() => Response.json({ accessToken: 'carol-only', scope: 'repo', login: 'carol' }), ['carol'])
    expect(await withUserScope('carol', () => githubCredentials().chain('github.com'))).toEqual([{ source: 'account', token: 'carol-only' }])
    expect(withCarol).toEqual([{ path: '/v1/vault/read', authorization: 'Bearer delegated-carol', body: JSON.stringify({ ref: GITHUB }) }])
    // Another person's call does not borrow it.
    await expect(withUserScope('dave', () => githubCredentials().chain('github.com'))).rejects.toThrow('Reconnect')
    expect(withCarol).toHaveLength(1)
  })
  test('host-scoped calls keep their host connection', async () => {
    vault().save(null, GITHUB, { accessToken: 'host-only' })
    expect(await vault().read(null, GITHUB, token)).toEqual({ accessToken: 'host-only' })
  })
  test('the owner of a personal host connects on that host until it is linked, and on the account once it is', async () => {
    // WHY: signed in means the account (docs/plans/cloud-vault.md §2.5): the linked
    // owner's logins are their account's, so every host of theirs reads the same ones.
    useHostUser({ localId: 'mac' })
    try {
      const calls = linkAccount(() => Response.json({ accessToken: 'account-copy' }))
      values.set('google-oauth', JSON.stringify({ accessToken: 'host-only' }))
      expect(credentialKeyFor(localOwner)).toBe('local:mac')
      expect(credentialLocationOf('local:mac')).toEqual({ kind: 'host' })
      expect(await vault().read('local:mac', GOOGLE, token)).toEqual({ accessToken: 'host-only' })
      expect(calls).toEqual([])
      useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
      for (const owner of [localOwner, remoteOwner]) {
        const personKey = credentialKeyFor(owner)
        expect(personKey).toBe('alice')
        expect(credentialLocationOf(personKey)).toEqual({ kind: 'account', accountId: 'alice' })
        expect(await vault().read(personKey, GOOGLE, token)).toEqual({ accessToken: 'account-copy' })
      }
      expect(calls.map((call) => call.path)).toEqual(['/v1/vault/read', '/v1/vault/read'])
    } finally {
      useHostUser(null)
    }
  })
  test('a cloud-managed host keeps account connections for its remote owner and members', () => {
    expect(credentialLocationOf(credentialKeyFor({ kind: 'org-member', userId: 'bob', organizationId: 'org', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'd', deviceLabel: 'Web', expiresAt: Date.now() + 60_000 }))).toEqual({ kind: 'account', accountId: 'bob' })
    adoptProvisionedRegistration({ organizationId: 'org' })
    useHostUser({ localId: 'vm', account: { accountId: 'alice' } })
    try {
      // WHY: a managed host is nobody's machine, so even its owner's logins are their account's.
      expect(credentialLocationOf(credentialKeyFor(remoteOwner))).toEqual({ kind: 'account', accountId: 'alice' })
    } finally {
      useHostUser(null)
    }
  })
  test('a guest has no logins at all (docs/plans/access-model.md D1)', async () => {
    const calls = linkAccount(() => Response.json({ accessToken: 'sharer-copy' }), ['alice', 'bob'])
    values.set('github-oauth', JSON.stringify({ accessToken: 'host-only' }))
    expect(credentialLocationOf('guest:maya')).toEqual({ kind: 'none' })
    expect(await vault().read('guest:maya', GITHUB, token)).toBeNull()
    expect(() => vault().save('guest:maya', GITHUB, { accessToken: 'x' })).toThrow('account website')
    expect(calls).toEqual([])
  })
  test('missing account authority never falls back to another local login', async () => {
    values.set('github-oauth', JSON.stringify({ accessToken: 'host-only' }))
    // Unlinked: there is no account plane to ask, and the host's own login is not bob's.
    await expect(vault().read('bob', GITHUB, token)).rejects.toThrow('not linked')
    expect(touches).toEqual([])
  })
  test('an account-scoped call never writes or clears the host store', async () => {
    expect(() => vault().save('bob', GOOGLE, { accessToken: 'x' })).toThrow('account website')
    expect(() => vault().remove('bob', GOOGLE)).toThrow('account website')
    expect(touches).toEqual([])
  })
  test('disconnect and outage are checked on the next call without a stale token cache', async () => {
    let status = 200
    const calls = linkAccount(() => Response.json({ accessToken: 'alice' }, { status }))
    expect(await vault().read('alice', GITHUB, token)).toEqual({ accessToken: 'alice' })
    status = 404
    expect(await vault().read('alice', GITHUB, token)).toBeNull()
    status = 503
    await expect(vault().read('alice', GITHUB, token)).rejects.toThrow('unavailable')
    expect(calls.map((call) => call.path)).toEqual(Array(3).fill('/v1/vault/read'))
  })
})
