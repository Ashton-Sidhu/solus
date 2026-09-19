import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SeatChangedEvent } from '@solus/contracts/seats'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §5: on the workspace service a seat is a
// vault row. A relayed login's file is taken in and deleted; a pasted token goes
// straight in; disconnect deletes the row; without a key every call says so.

let VaultSeatManager: typeof import('@solus/server/vault/vault-seats')['VaultSeatManager']
let vault: typeof import('@solus/server/vault/vault')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
const previousKey = process.env.SOLUS_VAULT_KEY
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-vault-seats-'))
  process.env.SOLUS_DATA_DIR = dataDir
  process.env.SOLUS_VAULT_KEY = randomBytes(32).toString('base64')
  ;({ VaultSeatManager } = await import('@solus/server/vault/vault-seats'))
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

function manager() {
  const seats = new VaultSeatManager({ seatsRoot: join(dataDir, 'seats') })
  const events: SeatChangedEvent[] = []
  seats.onChanged((event) => events.push(event))
  return { seats, events }
}

describe('a relayed login on the service', () => {
  test('the file the CLI wrote is taken into the vault and deleted from disk', async () => {
    const { seats, events } = manager()
    await seats.markConnecting('bob', 'claude-code')
    expect((await seats.status('bob', 'claude-code')).state).toBe('connecting')
    const home = seats.homeFor('bob', 'claude-code')
    const credentials = JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: 1_800_000_000_000 } })
    writeFileSync(join(home, '.credentials.json'), credentials)
    const status = await seats.markConnected('bob', 'claude-code', 'login')
    expect(status).toMatchObject({ state: 'connected', method: 'login', usageCapable: true })
    expect(existsSync(join(home, '.credentials.json'))).toBe(false)
    expect(await vault.readCredential('bob', 'claude-code')).toEqual({
      version: 1, method: 'login', material: { files: { '.credentials.json': credentials } }, expiresAt: 1_800_000_000_000,
    })
    expect(events.map((event) => event.state)).toEqual(['connecting', 'connected'])
  })

  test('a login that left no file (the keychain) fails the connect and says where the service must run', async () => {
    const { seats, events } = manager()
    await seats.markConnecting('cara', 'codex')
    const status = await seats.markConnected('cara', 'codex', 'login')
    expect(status.state).toBe('none')
    expect(status.error).toMatch(/must run where the CLI writes a credential file/)
    expect(events.at(-1)).toMatchObject({ state: 'none', error: expect.stringMatching(/credential file/) })
    expect(await vault.readCredential('cara', 'codex')).toBeNull()
  })
})

describe('tokens and removal', () => {
  test('a pasted token goes into the vault; disconnect deletes it; remove counts what it deleted', async () => {
    const { seats } = manager()
    expect(await seats.storeToken('dan', 'claude-code', ' sk-ant-oat01-x \n')).toMatchObject({ state: 'connected', method: 'token', usageCapable: false })
    expect(await vault.readCredential('dan', 'claude-code')).toMatchObject({ method: 'token', material: { token: 'sk-ant-oat01-x' } })
    await expect(seats.storeToken('dan', 'codex', 'not json')).rejects.toThrow(/auth\.json/)
    await seats.storeToken('dan', 'codex', '{"tokens":{"access_token":"x"}}')
    expect(await vault.readCredential('dan', 'codex')).toMatchObject({ method: 'token', material: { files: { 'auth.json': '{"tokens":{"access_token":"x"}}\n' } } })
    expect((await seats.list('dan')).map((status) => status.state)).toEqual(['connected', 'connected'])

    expect((await seats.disconnect('dan', 'claude-code')).state).toBe('none')
    expect(await vault.readCredential('dan', 'claude-code')).toBeNull()
    expect(await seats.remove('dan')).toBe(1)
    expect(await vault.readCredential('dan', 'codex')).toBeNull()
    expect(existsSync(join(dataDir, 'seats', 'codex', 'dan'))).toBe(false)
    expect(await seats.sweep()).toBe(0)
  })
})

describe('without a vault key', () => {
  test('every seat call answers VAULT_NOT_CONFIGURED', async () => {
    const { seats } = manager()
    const key = process.env.SOLUS_VAULT_KEY
    delete process.env.SOLUS_VAULT_KEY
    vault.resetVaultForTests()
    try {
      expect(vault.vaultConfigured()).toBe(false)
      await expect(seats.list('erin')).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' })
      await expect(seats.storeToken('erin', 'claude-code', 'x')).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' })
      await expect(seats.disconnect('erin', 'claude-code')).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' })
      expect(() => seats.homeFor('erin', 'claude-code')).toThrow(/vault key/)
    } finally {
      process.env.SOLUS_VAULT_KEY = key
      vault.resetVaultForTests()
    }
  })
})
