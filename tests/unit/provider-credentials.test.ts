import { hostAudience } from '@solus/contracts/uplink'
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
const { readProviderCredential, writeProviderCredential, clearProviderCredential } = await import('@solus/server/vault/provider-credentials')
const { useIntegrationExecutor, rememberPersonToken, useDelegatedTokens, resetAccountIntegrationsForTests } = await import('@solus/server/vault/account-integrations')
const { actorFor, credentialUserFor } = await import('@solus/server/admission/actor')
const { userKey } = await import('@solus/contracts/user')
type Principal = import('@solus/server/admission/principal').Principal
/** The credential scope `SolusServer.handle()` sets for a caller (plans/012 §4). */
const credentialKeyFor = (principal: Principal): string | null => {
  const user = credentialUserFor(actorFor(principal))
  return user ? userKey(user) : null
}
const { adoptProvisionedLink, resetHostCategoryForTests } = await import('@solus/server/host/host-category')
const { githubCredentialChain } = await import('@solus/server/providers/github/credentials')
const token = z.object({ accessToken: z.string() })
const realFetch = globalThis.fetch
const localOwner = { kind: 'local-owner', deviceId: null, deviceLabel: 'This Mac' } as const
const remoteOwner = { kind: 'remote-owner', userId: 'alice', deviceId: 'device', deviceLabel: 'Web', expiresAt: Date.now() + 60_000 } as const
afterEach(() => { resetAccountIntegrationsForTests(); values.clear(); touches.length = 0; globalThis.fetch = realFetch; resetHostCategoryForTests() })
afterAll(() => { if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previousDataDir; rmSync(temp, { recursive: true, force: true }) })

/** A runner linked to the account backend, holding alice's current access token. */
function linkAccount(respond: (path: string) => Response): string[] {
  const calls: string[] = []
  const now = Math.floor(Date.now() / 1000)
  useIntegrationExecutor({
    link: () => ({ hostId: 'h1', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', hostname: 'h-h1.test', proxiedPort: 1, connectionGeneration: 1 }),
    hostToken: () => 'host-token',
  })
  rememberPersonToken('alice-token', { iss: 'https://account.test', aud: hostAudience('h1'), sub: 'alice', deviceId: 'd1', jti: 'j1', iat: now, exp: now + 300, access: 'org-member' })
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    calls.push(path)
    return respond(path)
  }) as typeof fetch
  return calls
}

describe('account integration identity', () => {
  test('GitHub account requests never fall back to checkout, host, or gh credentials', async () => {
    values.set('github-oauth', JSON.stringify({ accessToken: 'wrong-host-user' }))
    let connected = true
    linkAccount(() => connected ? Response.json({ accessToken: 'alice-only', scope: 'repo', login: 'alice' }) : Response.json({}, { status: 404 }))
    expect(await withUserScope('alice', () => githubCredentialChain('github.com', '/unrelated/checkout'))).toEqual([{ source: 'account', token: 'alice-only' }])
    connected = false
    expect(await withUserScope('alice', () => githubCredentialChain('github.com', '/unrelated/checkout'))).toEqual([])
    expect(await withUserScope('alice', () => githubCredentialChain('enterprise.example'))).toEqual([])
    expect(touches).toEqual([])
  })
  test('after the person\'s token expires, the host keeps their own connection with its delegation for them, and nobody else\'s', async () => {
    // WHY: work continues after every client closed (plans/010-standard-oauth.md); its
    // tools still act as its person, and only as that person.
    const bodies: string[] = []
    useIntegrationExecutor({
      link: () => ({ hostId: 'h1', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', hostname: 'h-h1.test', proxiedPort: 1, connectionGeneration: 1 }),
      hostToken: () => 'host-token',
    })
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return Response.json({ accessToken: 'carol-only', scope: 'repo', login: 'carol' })
    }) as typeof fetch
    // No live token and no delegation for carol: nothing is sent, and the call says so.
    await expect(withUserScope('carol', () => githubCredentialChain('github.com'))).rejects.toThrow('Reconnect')
    expect(bodies).toEqual([])
    useDelegatedTokens(async (userId) => (userId === 'carol' ? 'carol-delegated' : null))
    expect(await withUserScope('carol', () => githubCredentialChain('github.com'))).toEqual([{ source: 'account', token: 'carol-only' }])
    expect(JSON.parse(bodies.at(-1)!)).toEqual({ accessToken: 'carol-delegated' })
    // Another person's call does not borrow it.
    await expect(withUserScope('dave', () => githubCredentialChain('github.com'))).rejects.toThrow('Reconnect')
    expect(bodies).toHaveLength(1)
  })
  test('host-scoped calls keep their host connection', async () => {
    await withUserScope(null, () => writeProviderCredential('github', { accessToken: 'host-only' }))
    expect(await withUserScope(null, () => readProviderCredential('github', token))).toEqual({ accessToken: 'host-only' })
  })
  test('the owner of a personal host connects on that host, not on the account website', async () => {
    // Signed in or not, locally or remotely: each host keeps its owner's own
    // GitHub, Google, and Atlassian connections.
    const calls = linkAccount(() => Response.json({ accessToken: 'account-copy' }))
    values.set('google-oauth', JSON.stringify({ accessToken: 'host-only' }))
    for (const owner of [localOwner, remoteOwner]) {
      const userId = credentialKeyFor(owner)
      expect(userId).toBeNull()
      expect(await withUserScope(userId, () => readProviderCredential('google', token))).toEqual({ accessToken: 'host-only' })
    }
    expect(calls).toEqual([])
  })
  test('a cloud-managed host keeps account connections for its remote owner and members', () => {
    expect(credentialKeyFor({ kind: 'org-member', userId: 'bob', organizationId: 'org', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'd', deviceLabel: 'Web', expiresAt: Date.now() + 60_000 })).toBe('bob')
    adoptProvisionedLink({ organizationId: 'org' })
    expect(credentialKeyFor(remoteOwner)).toBe('alice')
    expect(credentialKeyFor(localOwner)).toBeNull()
  })
  test('missing account authority never falls back to another local login', async () => {
    values.set('github-oauth', JSON.stringify({ accessToken: 'host-only' }))
    await expect(withUserScope('bob', () => readProviderCredential('github', token))).rejects.toThrow('Reconnect')
    expect(touches).toEqual([])
  })
  test('an account-scoped call never writes or clears the host store', async () => {
    await expect(withUserScope('bob', () => writeProviderCredential('google', { accessToken: 'x' }))).rejects.toThrow('account website')
    await expect(withUserScope('bob', () => clearProviderCredential('google'))).rejects.toThrow('account website')
    expect(touches).toEqual([])
  })
  test('disconnect and outage are checked on the next call without a stale token cache', async () => {
    let status = 200
    const calls = linkAccount(() => Response.json({ accessToken: 'alice' }, { status }))
    expect(await withUserScope('alice', () => readProviderCredential('github', token))).toEqual({ accessToken: 'alice' })
    status = 404
    expect(await withUserScope('alice', () => readProviderCredential('github', token))).toBeNull()
    status = 503
    await expect(withUserScope('alice', () => readProviderCredential('github', token))).rejects.toThrow('unavailable')
    expect(calls).toEqual(Array(3).fill('/v1/integrations/github/credential'))
  })
})
