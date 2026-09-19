import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { SecretStore } from '@solus/server/platform/secrets'
import type { VaultTransport } from '@solus/server/vault/vault-client'
import type { RunnerGrantInfo } from '@solus/server/server/uplink/runner-delivery'
import type { CredentialMaterial } from '@solus/server/server/uplink/runner-protocol'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §22: where a GitHub, Google, or Atlassian
// credential lives depends on the process and the scoped person. The workspace
// service keeps one vault row per person and never touches its secret store; a
// runner holding a grant leases a member's row, keeps it in memory only, and
// writes a refreshed token back under the version it leased; a signed-out host
// and the host's owner keep the secret store.

/** The host's keyring in one map, with a log of every touch. */
const records = new Map<string, unknown>()
const secretTouches: string[] = []
const store: SecretStore = {
  loadJson: <T>(key: string) => {
    secretTouches.push(`load ${key}`)
    return (records.get(key) as T | undefined) ?? null
  },
  saveJson: (key: string, _path: string, value: unknown) => {
    secretTouches.push(`save ${key}`)
    records.set(key, value)
  },
  remove: (key: string) => {
    secretTouches.push(`remove ${key}`)
    records.delete(key)
  },
  canSave: () => true,
}
mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))

interface VaultRow { version: number; method: 'login' | 'token'; material: CredentialMaterial; expiresAt: number | null }

/** The service in miniature: one row per (user, provider) and a log of every call. */
class FakeService implements VaultTransport {
  rows = new Map<string, VaultRow>()
  calls: string[] = []
  grant: RunnerGrantInfo | null = { hostId: 'runner-1', organizationId: 'org1', workspaceUrl: 'https://ws', ownerUserId: null }
  private listeners = new Set<(info: RunnerGrantInfo | null) => void>()

  currentGrant(): RunnerGrantInfo | null { return this.grant }
  onGrant(listener: (info: RunnerGrantInfo | null) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  setGrant(info: RunnerGrantInfo | null): void {
    this.grant = info
    for (const listener of this.listeners) listener(info)
  }
  put(userId: string, provider: string, row: VaultRow): void { this.rows.set(`${userId}/${provider}`, row) }

  async call<T>(path: string, body: unknown, schema: z.ZodType<T>): ReturnType<VaultTransport['call']> {
    const request = z.object({ userId: z.string(), provider: z.string(), baseVersion: z.number().optional(), material: z.custom<CredentialMaterial>().optional(), expiresAt: z.number().nullable().optional() }).parse(body)
    const key = `${request.userId}/${request.provider}`
    this.calls.push(`${path.replace('/runner/credentials/', '')} ${key}`)
    const answer = (value: unknown) => ({ kind: 'ok' as const, body: schema.parse(value) })
    if (path === '/runner/credentials/lease') {
      const row = this.rows.get(key)
      return row ? answer(row) : { kind: 'refused', status: 404, error: 'no_credential' }
    }
    if (path === '/runner/credentials/writeback') {
      const row = this.rows.get(key)
      if (!row) return { kind: 'refused', status: 404, error: 'no_credential' }
      if (row.version !== request.baseVersion) return { kind: 'refused', status: 409, error: 'version_conflict' }
      const next: VaultRow = { ...row, version: row.version + 1, material: request.material!, expiresAt: request.expiresAt ?? null }
      this.rows.set(key, next)
      return answer({ version: next.version })
    }
    return { kind: 'refused', status: 404, error: null }
  }
}

const googleSchema = z.object({ refreshToken: z.string(), accessToken: z.string(), expiresAt: z.number() })
const githubSchema = z.object({ accessToken: z.string(), scope: z.string() })
const googleJson = (accessToken: string, expiresAt: number) => JSON.stringify({ refreshToken: 'r', accessToken, expiresAt })
const fileOf = (json: string): CredentialMaterial => ({ files: { 'credential.json': json } })

let credentials: typeof import('@solus/server/vault/provider-credentials')
let scope: typeof import('@solus/server/vault/credential-scope')
let workspaceMode: typeof import('@solus/server/server/workspace-mode')
let vault: typeof import('@solus/server/vault/vault')
let dbModule: typeof import('@solus/server/db')
let VaultClient: typeof import('@solus/server/vault/vault-client')['VaultClient']

const previousEnv = { ...process.env }
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-provider-credentials-'))
  process.env.SOLUS_DATA_DIR = dataDir
  process.env.SOLUS_VAULT_KEY = randomBytes(32).toString('base64')
  delete process.env.SOLUS_WORKSPACE
  credentials = await import('@solus/server/vault/provider-credentials')
  scope = await import('@solus/server/vault/credential-scope')
  workspaceMode = await import('@solus/server/server/workspace-mode')
  vault = await import('@solus/server/vault/vault')
  dbModule = await import('@solus/server/db')
  ;({ VaultClient } = await import('@solus/server/vault/vault-client'))
  vault.resetVaultForTests()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  process.env = { ...previousEnv }
  workspaceMode.resetWorkspaceModeForTests()
  vault.resetVaultForTests()
})

function setWorkspaceMode(on: boolean): void {
  if (on) process.env.SOLUS_WORKSPACE = '1'
  else delete process.env.SOLUS_WORKSPACE
  workspaceMode.resetWorkspaceModeForTests()
}

beforeEach(() => {
  records.clear()
  secretTouches.length = 0
  credentials.resetProviderCredentialsForTests()
  setWorkspaceMode(false)
})

describe('a signed-out host, and its owner', () => {
  test('read, write, and clear the secret store, whoever the process is not scoped to', async () => {
    await credentials.writeProviderCredential('github', { accessToken: 'host-token', scope: 'repo' })
    expect(await credentials.readProviderCredential('github', githubSchema)).toEqual({ accessToken: 'host-token', scope: 'repo' })
    expect(credentials.readHostCredential('github', githubSchema)?.accessToken).toBe('host-token')
    await credentials.clearProviderCredential('github')
    expect(await credentials.readProviderCredential('github', githubSchema)).toBeNull()
    expect(secretTouches).toEqual(['save github-oauth', 'load github-oauth', 'load github-oauth', 'remove github-oauth', 'load github-oauth'])
  })

  test("a scoped member on a host without a grant still reads the host's store", async () => {
    // WHY: a personal host has no vault to lease from; a member there uses the host's connections, as before.
    records.set('google-oauth', { refreshToken: 'r', accessToken: 'host-google', expiresAt: 1 })
    const read = await scope.withCredentialScope('bob', () => credentials.readProviderCredential('google', googleSchema))
    expect(read?.accessToken).toBe('host-google')
  })
})

describe('the workspace service', () => {
  test("reads and writes the scoped person's vault row, and never the secret store", async () => {
    setWorkspaceMode(true)
    await scope.withCredentialScope('alice', () => credentials.writeProviderCredential('google', { refreshToken: 'r', accessToken: 'alice-google', expiresAt: 1_800_000_000_000 }))
    const stored = await vault.readCredential('alice', 'google')
    expect(stored).toMatchObject({ version: 1, method: 'login', expiresAt: 1_800_000_000_000 })
    expect(stored?.material.files?.['credential.json']).toBe(JSON.stringify({ refreshToken: 'r', accessToken: 'alice-google', expiresAt: 1_800_000_000_000 }))
    expect(await scope.withCredentialScope('alice', () => credentials.readProviderCredential('google', googleSchema))).toMatchObject({ accessToken: 'alice-google' })
    // Bob's row is his own; the service has no host connection to fall back to.
    expect(await scope.withCredentialScope('bob', () => credentials.readProviderCredential('google', googleSchema))).toBeNull()
    expect(await credentials.readProviderCredential('google', googleSchema)).toBeNull()
    await expect(credentials.writeProviderCredential('google', { refreshToken: 'r', accessToken: 'x', expiresAt: 1 })).rejects.toThrow(/No signed-in person/)
    // Disconnecting deletes the person's row only.
    await scope.withCredentialScope('alice', () => credentials.clearProviderCredential('google'))
    expect(await vault.readCredential('alice', 'google')).toBeNull()
    expect(secretTouches).toEqual([])
  })
})

describe('a runner holding a grant', () => {
  function runner(): FakeService {
    const service = new FakeService()
    credentials.useProviderVault(new VaultClient(service))
    return service
  }

  test("leases the member's row once, keeps it in memory, and asks again after five minutes", async () => {
    const service = runner()
    service.put('alice', 'google', { version: 3, method: 'login', material: fileOf(googleJson('leased', 1_800_000_000_000)), expiresAt: 1_800_000_000_000 })
    const read = () => scope.withCredentialScope('alice', () => credentials.readProviderCredential('google', googleSchema))
    expect((await read())?.accessToken).toBe('leased')
    expect((await read())?.accessToken).toBe('leased')
    expect(service.calls).toEqual(['lease alice/google'])
    // Nothing of Alice's touched the host's keyring.
    expect(secretTouches).toEqual([])
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 5 * 60_000 + 1
      await read()
    } finally {
      Date.now = realNow
    }
    expect(service.calls).toEqual(['lease alice/google', 'lease alice/google'])
  })

  test('writes a refreshed token back under the version leased; a conflict drops the copy', async () => {
    const service = runner()
    service.put('alice', 'google', { version: 1, method: 'login', material: fileOf(googleJson('old', 1_000)), expiresAt: 1_000 })
    await scope.withCredentialScope('alice', async () => {
      await credentials.readProviderCredential('google', googleSchema)
      await credentials.writeProviderCredential('google', { refreshToken: 'r', accessToken: 'new', expiresAt: 2_000 })
    })
    expect(service.rows.get('alice/google')).toMatchObject({ version: 2, expiresAt: 2_000, material: fileOf(googleJson('new', 2_000)) })
    // The copy now stands for version 2: the next read needs no lease.
    expect((await scope.withCredentialScope('alice', () => credentials.readProviderCredential('google', googleSchema)))?.accessToken).toBe('new')
    expect(service.calls).toEqual(['lease alice/google', 'writeback alice/google'])
    // Another runner refreshed first: this copy is stale and goes; the next read leases theirs.
    service.put('alice', 'google', { version: 5, method: 'login', material: fileOf(googleJson('theirs', 3_000)), expiresAt: 3_000 })
    await scope.withCredentialScope('alice', () => credentials.writeProviderCredential('google', { refreshToken: 'r', accessToken: 'mine', expiresAt: 2_500 }))
    expect((await scope.withCredentialScope('alice', () => credentials.readProviderCredential('google', googleSchema)))?.accessToken).toBe('theirs')
    expect(service.calls.slice(2)).toEqual(['writeback alice/google', 'lease alice/google'])
  })

  test('no credential is null, and the copy is dropped; the host owner keeps the secret store', async () => {
    const service = runner()
    service.put('alice', 'github', { version: 1, method: 'login', material: fileOf(JSON.stringify({ accessToken: 'alice-gh', scope: 'repo' })), expiresAt: null })
    expect((await scope.withCredentialScope('alice', () => credentials.readProviderCredential('github', githubSchema)))?.accessToken).toBe('alice-gh')
    service.rows.clear()
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 6 * 60_000
      expect(await scope.withCredentialScope('alice', () => credentials.readProviderCredential('github', githubSchema))).toBeNull()
    } finally {
      Date.now = realNow
    }
    // Dropped: a read inside the window leases again rather than answering the old copy.
    await scope.withCredentialScope('alice', () => credentials.readProviderCredential('github', githubSchema))
    expect(service.calls).toEqual(['lease alice/github', 'lease alice/github', 'lease alice/github'])
    // A runner forgets its copy on clear; it never deletes the person's row.
    await scope.withCredentialScope('alice', () => credentials.clearProviderCredential('github'))
    expect(service.calls).toHaveLength(3)
    // The host's own owner is not a member to lease for.
    records.set('github-oauth', { accessToken: 'host-gh', scope: 'repo' })
    expect((await credentials.readProviderCredential('github', githubSchema))?.accessToken).toBe('host-gh')
    expect(secretTouches).toEqual(['load github-oauth'])
  })

  test('losing the grant forgets every leased copy', async () => {
    const service = runner()
    service.put('alice', 'github', { version: 1, method: 'login', material: fileOf(JSON.stringify({ accessToken: 'alice-gh', scope: 'repo' })), expiresAt: null })
    await scope.withCredentialScope('alice', () => credentials.readProviderCredential('github', githubSchema))
    service.setGrant(null)
    // Without a grant the runner is a plain host again: the secret store answers.
    expect(await scope.withCredentialScope('alice', () => credentials.readProviderCredential('github', githubSchema))).toBeNull()
    expect(secretTouches).toEqual(['load github-oauth'])
  })
})
