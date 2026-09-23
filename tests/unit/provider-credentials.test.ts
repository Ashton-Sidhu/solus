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
const { withCredentialScope } = await import('@solus/server/vault/credential-scope')
const { readProviderCredential, writeProviderCredential, clearProviderCredential } = await import('@solus/server/vault/provider-credentials')
const { useIntegrationExecutor, rememberIntegrationGrant, integrationUserFor, resetAccountIntegrationsForTests } = await import('@solus/server/vault/account-integrations')
const { resetManagedModeForTests } = await import('@solus/server/server/managed-mode')
const { githubCredentialChain } = await import('@solus/server/providers/github/credentials')
const token = z.object({ accessToken: z.string() })
const realFetch = globalThis.fetch
const localOwner = { kind: 'local-owner', deviceId: null, deviceLabel: 'This Mac' } as const
const remoteOwner = { kind: 'remote-owner', userId: 'alice', deviceId: 'device', deviceLabel: 'Web', expiresAt: Date.now() + 60_000 } as const
afterEach(() => { resetAccountIntegrationsForTests(); values.clear(); touches.length = 0; globalThis.fetch = realFetch; delete process.env.SOLUS_MANAGED; resetManagedModeForTests() })
afterAll(() => { if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previousDataDir; rmSync(temp, { recursive: true, force: true }) })

/** A runner linked to the account backend, holding alice's current user grant. */
function linkAccount(respond: (path: string) => Response): string[] {
  const calls: string[] = []
  const now = Math.floor(Date.now() / 1000)
  useIntegrationExecutor({
    link: () => ({ hostId: 'h1', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', hostname: 'h-h1.test', proxiedPort: 1, connectionGeneration: 1 }),
    hostToken: () => 'host-token',
  })
  rememberIntegrationGrant('alice-grant', { iss: 'https://account.test', aud: 'h1', sub: 'user:alice', deviceId: 'd1', jti: 'j1', iat: now, exp: now + 600, access: 'org-member' })
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
    expect(await withCredentialScope('alice', () => githubCredentialChain('github.com', '/unrelated/checkout'))).toEqual([{ source: 'account', token: 'alice-only' }])
    connected = false
    expect(await withCredentialScope('alice', () => githubCredentialChain('github.com', '/unrelated/checkout'))).toEqual([])
    expect(await withCredentialScope('alice', () => githubCredentialChain('enterprise.example'))).toEqual([])
    expect(touches).toEqual([])
  })
  test('host-scoped calls keep their host connection', async () => {
    await withCredentialScope(null, () => writeProviderCredential('github', { accessToken: 'host-only' }))
    expect(await withCredentialScope(null, () => readProviderCredential('github', token))).toEqual({ accessToken: 'host-only' })
  })
  test('the owner of a personal host connects on that host, not on the account website', async () => {
    // Signed in or not, locally or remotely: each host keeps its owner's own
    // GitHub, Google, and Atlassian connections.
    const calls = linkAccount(() => Response.json({ accessToken: 'account-copy' }))
    values.set('google-oauth', JSON.stringify({ accessToken: 'host-only' }))
    for (const owner of [localOwner, remoteOwner]) {
      const userId = integrationUserFor(owner)
      expect(userId).toBeNull()
      expect(await withCredentialScope(userId, () => readProviderCredential('google', token))).toEqual({ accessToken: 'host-only' })
    }
    expect(calls).toEqual([])
  })
  test('a cloud-managed host keeps account connections for its remote owner and members', () => {
    expect(integrationUserFor({ kind: 'org-member', userId: 'bob', organizationId: 'org', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'd', deviceLabel: 'Web', expiresAt: Date.now() + 60_000 })).toBe('bob')
    process.env.SOLUS_MANAGED = '1'
    resetManagedModeForTests()
    expect(integrationUserFor(remoteOwner)).toBe('alice')
    expect(integrationUserFor(localOwner)).toBeNull()
  })
  test('missing account authority never falls back to another local login', async () => {
    values.set('github-oauth', JSON.stringify({ accessToken: 'host-only' }))
    await expect(withCredentialScope('bob', () => readProviderCredential('github', token))).rejects.toThrow('Reconnect')
    expect(touches).toEqual([])
  })
  test('an account-scoped call never writes or clears the host store', async () => {
    await expect(withCredentialScope('bob', () => writeProviderCredential('google', { accessToken: 'x' }))).rejects.toThrow('account website')
    await expect(withCredentialScope('bob', () => clearProviderCredential('google'))).rejects.toThrow('account website')
    expect(touches).toEqual([])
  })
  test('disconnect and outage are checked on the next call without a stale token cache', async () => {
    let status = 200
    const calls = linkAccount(() => Response.json({ accessToken: 'alice' }, { status }))
    expect(await withCredentialScope('alice', () => readProviderCredential('github', token))).toEqual({ accessToken: 'alice' })
    status = 404
    expect(await withCredentialScope('alice', () => readProviderCredential('github', token))).toBeNull()
    status = 503
    await expect(withCredentialScope('alice', () => readProviderCredential('github', token))).rejects.toThrow('unavailable')
    expect(calls).toEqual(Array(3).fill('/v1/integrations/github/credential'))
  })
})
