import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §5: a credential is stored once per person
// and provider, encrypted under the service key; every replacement advances the
// version; a write back lands only against the version it leased; the refresh
// lock is one runner's at a time until it expires or is released.

let vault: typeof import('@solus/server/vault/vault')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
const previousKey = process.env.SOLUS_VAULT_KEY
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-vault-'))
  process.env.SOLUS_DATA_DIR = dataDir
  process.env.SOLUS_VAULT_KEY = randomBytes(32).toString('base64')
  vault = await import('@solus/server/vault/vault')
  dbModule = await import('@solus/server/db')
  vault.resetVaultForTests()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.SOLUS_VAULT_KEY
  else process.env.SOLUS_VAULT_KEY = previousKey
  vault.resetVaultForTests()
})

const claudeFile = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt } })
function codexFile(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, sub: 'u' })).toString('base64url')
  return JSON.stringify({ tokens: { access_token: `hdr.${payload}.sig`, refresh_token: 'r' } })
}

describe('credentials', () => {
  test('a stored credential reads back whole; a replacement advances the version; nothing readable is stored', async () => {
    expect(vault.vaultConfigured()).toBe(true)
    const material = { files: { '.credentials.json': claudeFile(1_800_000_000_000) } }
    expect(await vault.putCredential('alice', 'claude-code', 'login', material, 1_800_000_000_000)).toBe(1)
    expect(await vault.readCredential('alice', 'claude-code')).toEqual({ version: 1, method: 'login', material, expiresAt: 1_800_000_000_000 })
    expect(await vault.putCredential('alice', 'claude-code', 'token', { token: 'sk-ant-oat01-x' }, null)).toBe(2)
    expect(await vault.readCredential('alice', 'claude-code')).toEqual({ version: 2, method: 'token', material: { token: 'sk-ant-oat01-x' }, expiresAt: null })
    // The row holds ciphertext: the token is not in it in the clear.
    const { sql } = await import('drizzle-orm')
    const { getDatabase } = await import('@solus/server/db/database')
    const row = await getDatabase().get<{ ciphertext: string }>(sql`SELECT ciphertext FROM credential_vault WHERE user_id = 'alice' AND provider = 'claude-code'`)
    expect(row?.ciphertext.startsWith('v1.')).toBe(true)
    expect(row?.ciphertext.includes('sk-ant')).toBe(false)
    // One person's credential is not another's.
    expect(await vault.readCredential('bob', 'claude-code')).toBeNull()
    expect(await vault.deleteCredential('alice', 'claude-code')).toBe(true)
    expect(await vault.readCredential('alice', 'claude-code')).toBeNull()
    expect(await vault.deleteCredential('alice', 'claude-code')).toBe(false)
  })

  test('a write back lands against the version leased; a newer version refuses it; no row is no credential', async () => {
    await vault.putCredential('cara', 'codex', 'login', { files: { 'auth.json': codexFile(1) } }, 1_000)
    expect(await vault.writeBack('cara', 'codex', 1, { files: { 'auth.json': codexFile(2) } }, 2_000)).toEqual({ kind: 'ok', version: 2 })
    expect(await vault.readCredential('cara', 'codex')).toMatchObject({ version: 2, expiresAt: 2_000, material: { files: { 'auth.json': codexFile(2) } } })
    // A runner that leased version 1 refreshed too late: its copy is stale.
    expect(await vault.writeBack('cara', 'codex', 1, { files: { 'auth.json': codexFile(3) } }, 3_000)).toEqual({ kind: 'version_conflict' })
    expect((await vault.readCredential('cara', 'codex'))?.version).toBe(2)
    expect(await vault.writeBack('nobody', 'codex', 1, { files: {} }, null)).toEqual({ kind: 'no_credential' })
  })
})

describe('the refresh lock', () => {
  test('one runner holds it; a second waits on its expiry; the holder may take it again, release it, or let it lapse', async () => {
    const first = await vault.acquireLock('dan', 'claude-code', 'runner-1', 60_000)
    expect(first.acquired).toBe(true)
    const second = await vault.acquireLock('dan', 'claude-code', 'runner-2', 60_000)
    expect(second).toEqual({ acquired: false, expiresAt: first.expiresAt })
    // The holder asking again extends its own lock.
    expect((await vault.acquireLock('dan', 'claude-code', 'runner-1', 90_000)).acquired).toBe(true)
    // Another runner cannot release it.
    expect(await vault.releaseLock('dan', 'claude-code', 'runner-2')).toBe(false)
    expect(await vault.releaseLock('dan', 'claude-code', 'runner-1')).toBe(true)
    expect((await vault.acquireLock('dan', 'claude-code', 'runner-2', 60_000)).acquired).toBe(true)
    await vault.releaseLock('dan', 'claude-code', 'runner-2')
    // An expired lock is taken over.
    expect((await vault.acquireLock('dan', 'claude-code', 'runner-1', -1)).acquired).toBe(true)
    expect((await vault.acquireLock('dan', 'claude-code', 'runner-2', 60_000)).acquired).toBe(true)
    await vault.releaseLock('dan', 'claude-code', 'runner-2')
  })
})

describe('expiry', () => {
  test('Claude says it in milliseconds; Codex in a JWT exp of seconds; a pasted token says nothing', () => {
    expect(vault.credentialExpiresAt('claude-code', { files: { '.credentials.json': claudeFile(1_800_000_000_123) } })).toBe(1_800_000_000_123)
    expect(vault.credentialExpiresAt('codex', { files: { 'auth.json': codexFile(1_800_000_000) } })).toBe(1_800_000_000_000)
    expect(vault.credentialExpiresAt('claude-code', { token: 'sk-ant-oat01-x' })).toBeNull()
    expect(vault.credentialExpiresAt('claude-code', { files: { '.credentials.json': 'not json' } })).toBeNull()
    expect(vault.credentialExpiresAt('codex', { files: { 'auth.json': JSON.stringify({ tokens: { access_token: 'opaque' } }) } })).toBeNull()
  })
})

describe('organization members', () => {
  test('an admitted member may be leased for; a stranger may not', async () => {
    expect(await vault.isOrganizationMember('org1', 'erin')).toBe(false)
    await vault.touchOrganizationMember('org1', 'erin', 'Erin')
    await vault.touchOrganizationMember('org1', 'erin', 'Erin E.')
    expect(await vault.isOrganizationMember('org1', 'erin')).toBe(true)
    expect(await vault.isOrganizationMember('org2', 'erin')).toBe(false)
  })
})
