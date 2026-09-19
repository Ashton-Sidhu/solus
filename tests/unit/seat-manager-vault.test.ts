import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import { SeatManager, SeatRequiredError } from '@solus/server/seats/seat-manager'
import { VaultClient, type VaultTransport } from '@solus/server/vault/vault-client'
import type { RunnerGrantInfo } from '@solus/server/server/uplink/runner-delivery'
import type { CredentialMaterial } from '@solus/server/server/uplink/runner-protocol'

// docs/plans/cloud-service-model.md §5, the runner's side: a member's turn leases
// their credential, writes it into their own seat directory only, takes the
// refresh lock when a refresh is likely, writes a changed credential back under
// the version it leased, and drops its copy when the vault says another runner
// refreshed first, or that there is nothing to lease.

interface VaultRow { version: number; method: 'login' | 'token'; material: CredentialMaterial; expiresAt: number | null }

/** The service in miniature: one row per (user, provider), a lock table, and a log of every call. */
class FakeService implements VaultTransport {
  rows = new Map<string, VaultRow>()
  locks = new Map<string, { hostId: string; expiresAt: number }>()
  calls: Array<{ path: string; body: unknown }> = []
  grant: RunnerGrantInfo | null = { hostId: 'runner-1', organizationId: 'org1', workspaceUrl: 'https://ws', ownerUserId: null }
  offline = false
  private listeners = new Set<(info: RunnerGrantInfo | null) => void>()
  now = () => 1_000_000

  currentGrant(): RunnerGrantInfo | null { return this.grant }
  onGrant(listener: (info: RunnerGrantInfo | null) => void): () => void {
    this.listeners.add(listener)
    listener(this.grant)
    return () => { this.listeners.delete(listener) }
  }
  setGrant(info: RunnerGrantInfo | null): void {
    this.grant = info
    for (const listener of this.listeners) listener(info)
  }
  put(userId: string, provider: string, row: VaultRow): void { this.rows.set(`${userId}/${provider}`, row) }

  async call<T>(path: string, body: unknown, schema: z.ZodType<T>): ReturnType<VaultTransport['call']> {
    this.calls.push({ path, body })
    if (this.offline) return { kind: 'unreachable', error: 'down' }
    const request = body as { userId: string; provider: string; ttlMs?: number; baseVersion?: number; material?: CredentialMaterial; expiresAt?: number | null }
    const key = `${request.userId}/${request.provider}`
    const answer = (value: unknown) => ({ kind: 'ok' as const, body: schema.parse(value) })
    switch (path) {
      case '/runner/credentials/lease': {
        const row = this.rows.get(key)
        return row ? answer(row) : { kind: 'refused', status: 404, error: 'no_credential' }
      }
      case '/runner/credentials/lock': {
        const held = this.locks.get(key)
        if (held && held.expiresAt > this.now() && held.hostId !== 'runner-1') return answer({ acquired: false, expiresAt: held.expiresAt })
        const lock = { hostId: 'runner-1', expiresAt: this.now() + (request.ttlMs ?? 0) }
        this.locks.set(key, lock)
        return answer({ acquired: true, expiresAt: lock.expiresAt })
      }
      case '/runner/credentials/unlock':
        this.locks.delete(key)
        return answer({})
      case '/runner/credentials/writeback': {
        const row = this.rows.get(key)
        if (!row) return { kind: 'refused', status: 404, error: 'no_credential' }
        if (row.version !== request.baseVersion) return { kind: 'refused', status: 409, error: 'version_conflict' }
        const next: VaultRow = { ...row, version: row.version + 1, material: request.material!, expiresAt: request.expiresAt ?? null }
        this.rows.set(key, next)
        return answer({ version: next.version })
      }
    }
    return { kind: 'refused', status: 404, error: null }
  }
  paths(): string[] { return this.calls.map((call) => call.path.replace('/runner/credentials/', '')) }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'seat-vault-'))
  roots.push(root)
  const service = new FakeService()
  const slept: number[] = []
  const seats = new SeatManager({
    db: new Database(':memory:') as unknown as DatabaseSync,
    seatsRoot: join(root, 'seats'),
    hostClaudeDir: join(root, 'home', '.claude'),
    hostCodexHome: join(root, 'home', '.codex'),
    now: () => service.now(),
    sleep: async (ms) => { slept.push(ms); service.now = ((at) => () => at)(service.now() + ms) },
  })
  seats.useVault(new VaultClient(service))
  return { seats, service, root, slept, bobHome: join(root, 'seats', 'claude', 'bob') }
}

const claudeFile = (tag: string, expiresAt: number | null = 1_800_000_000_000) => JSON.stringify({ claudeAiOauth: { accessToken: tag, expiresAt } })

describe('leasing', () => {
  test('a lease writes the right files into the right person\'s home only, 0600, and an unchanged version is not written again', async () => {
    const { seats, service, bobHome, root } = harness()
    service.put('bob', 'claude-code', { version: 3, method: 'login', material: { files: { '.credentials.json': claudeFile('v3') } }, expiresAt: 1_800_000_000_000 })
    const seat = await seats.resolveForTurn('bob', 'claude-code')
    expect(seat).toMatchObject({ userId: 'bob', provider: 'claude-code', home: bobHome })
    expect(seat?.isHostLogin).toBeUndefined()
    expect(readFileSync(join(bobHome, '.credentials.json'), 'utf8')).toBe(claudeFile('v3'))
    expect(statSync(join(bobHome, '.credentials.json')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(root, 'seats', 'codex', 'bob'))).toBe(false)
    expect(existsSync(join(root, 'seats', 'claude', 'cara'))).toBe(false)
    // Far from expiry: no lock was taken.
    expect(service.paths()).toEqual(['lease'])

    // The same version again: the file the CLI holds is left alone.
    writeFileSync(join(bobHome, '.credentials.json'), 'touched by the CLI')
    await seats.resolveForTurn('bob', 'claude-code')
    expect(readFileSync(join(bobHome, '.credentials.json'), 'utf8')).toBe('touched by the CLI')
    // A newer version replaces it.
    service.put('bob', 'claude-code', { version: 4, method: 'login', material: { files: { '.credentials.json': claudeFile('v4') } }, expiresAt: 1_800_000_000_000 })
    await seats.resolveForTurn('bob', 'claude-code')
    expect(readFileSync(join(bobHome, '.credentials.json'), 'utf8')).toBe(claudeFile('v4'))
  })

  test('a pasted Claude token rides the env and leaves no file; the host login never asks the vault', async () => {
    const { seats, service, bobHome } = harness()
    service.put('bob', 'claude-code', { version: 1, method: 'token', material: { token: 'sk-ant-oat01-x' }, expiresAt: null })
    const seat = await seats.resolveForTurn('bob', 'claude-code')
    expect(seat?.envToken).toBe('sk-ant-oat01-x')
    expect(existsSync(join(bobHome, '.credentials.json'))).toBe(false)
    // A token is never refreshed by the CLI: no lock, and nothing to write back.
    expect(service.paths()).toEqual(['lease'])
    await seat!.release!()
    expect(service.paths()).toEqual(['lease'])
    expect(await seats.resolveForTurn('host-owner', 'claude-code')).toMatchObject({ isHostLogin: true })
    expect(service.paths()).toEqual(['lease'])
  })

  test('no credential in the vault: the local files are purged and the turn is refused toward Solus cloud', async () => {
    const { seats, service, bobHome } = harness()
    service.put('bob', 'claude-code', { version: 1, method: 'login', material: { files: { '.credentials.json': claudeFile('v1') } }, expiresAt: 1_800_000_000_000 })
    await seats.resolveForTurn('bob', 'claude-code')
    expect(existsSync(join(bobHome, '.credentials.json'))).toBe(true)
    service.rows.clear()
    let refusal: unknown
    try { await seats.resolveForTurn('bob', 'claude-code') } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(SeatRequiredError)
    expect((refusal as SeatRequiredError).message).toMatch(/in Solus cloud/)
    expect(existsSync(join(bobHome, '.credentials.json'))).toBe(false)
  })

  test('with no grant the local rows answer as before; losing the grant purges every leased credential', async () => {
    const { seats, service, bobHome } = harness()
    service.put('bob', 'claude-code', { version: 1, method: 'login', material: { files: { '.credentials.json': claudeFile('v1') } }, expiresAt: 1_800_000_000_000 })
    await seats.resolveForTurn('bob', 'claude-code')
    await seats.storeToken('cara', 'claude-code', 'cara-token')
    service.setGrant(null)
    expect(existsSync(join(bobHome, '.credentials.json'))).toBe(false)
    // Cara connected on this host directly: her credential is hers, and still resolves.
    expect((await seats.resolveForTurn('cara', 'claude-code'))?.envToken).toBe('cara-token')
    await expect(seats.resolveForTurn('bob', 'claude-code')).rejects.toThrow(/on this host/)
  })
})

describe('refresh and write back', () => {
  test('near expiry the lock is taken, a changed file goes back under the leased version, and the lock is released', async () => {
    const { seats, service, bobHome } = harness()
    const soon = service.now() + 60_000
    service.put('bob', 'claude-code', { version: 2, method: 'login', material: { files: { '.credentials.json': claudeFile('old', soon) } }, expiresAt: soon })
    const seat = await seats.resolveForTurn('bob', 'claude-code')
    expect(service.paths()).toEqual(['lease', 'lock'])
    expect(service.locks.get('bob/claude-code')).toMatchObject({ hostId: 'runner-1' })
    // The CLI refreshed during the turn.
    const later = service.now() + 3_600_000
    writeFileSync(join(bobHome, '.credentials.json'), claudeFile('fresh', later))
    await seat!.release!()
    expect(service.paths()).toEqual(['lease', 'lock', 'writeback', 'unlock'])
    expect(service.rows.get('bob/claude-code')).toMatchObject({ version: 3, expiresAt: later, material: { files: { '.credentials.json': claudeFile('fresh', later) } } })
    expect(service.locks.has('bob/claude-code')).toBe(false)
    // The next turn holds version 3 already: nothing is written, and nothing is locked.
    service.calls.length = 0
    await seats.resolveForTurn('bob', 'claude-code')
    expect(service.paths()).toEqual(['lease'])
    expect(readFileSync(join(bobHome, '.credentials.json'), 'utf8')).toBe(claudeFile('fresh', later))
  })

  test('an unchanged file is not written back; a login with no expiry still locks', async () => {
    const { seats, service } = harness()
    service.put('bob', 'codex', { version: 1, method: 'login', material: { files: { 'auth.json': '{"tokens":{}}' } }, expiresAt: null })
    const seat = await seats.resolveForTurn('bob', 'codex')
    expect(service.paths()).toEqual(['lease', 'lock'])
    await seat!.release!()
    expect(service.paths()).toEqual(['lease', 'lock', 'unlock'])
  })

  test('a write back that conflicts drops the local copy so the next lease takes the other runner\'s', async () => {
    const { seats, service, bobHome } = harness()
    service.put('bob', 'claude-code', { version: 1, method: 'login', material: { files: { '.credentials.json': claudeFile('v1') } }, expiresAt: 1_800_000_000_000 })
    const seat = await seats.resolveForTurn('bob', 'claude-code')
    // Another runner wrote version 2 while this turn ran; this runner refreshed too.
    service.put('bob', 'claude-code', { version: 2, method: 'login', material: { files: { '.credentials.json': claudeFile('theirs') } }, expiresAt: 1_800_000_000_000 })
    writeFileSync(join(bobHome, '.credentials.json'), claudeFile('mine'))
    await seat!.release!()
    expect(service.paths()).toEqual(['lease', 'writeback'])
    expect(existsSync(join(bobHome, '.credentials.json'))).toBe(false)
    expect(service.rows.get('bob/claude-code')?.material.files?.['.credentials.json']).toBe(claudeFile('theirs'))
    await seats.resolveForTurn('bob', 'claude-code')
    expect(readFileSync(join(bobHome, '.credentials.json'), 'utf8')).toBe(claudeFile('theirs'))
  })

  test('a lock another runner holds is waited on, two seconds at a time, and the credential is leased again after', async () => {
    const { seats, service, slept, bobHome } = harness()
    const soon = service.now() + 60_000
    service.put('bob', 'claude-code', { version: 1, method: 'login', material: { files: { '.credentials.json': claudeFile('stale', soon) } }, expiresAt: soon })
    service.locks.set('bob/claude-code', { hostId: 'runner-2', expiresAt: service.now() + 5_000 })
    // The other runner writes back and releases while this one waits.
    const originalCall = service.call.bind(service)
    service.call = async (path, body, schema) => {
      if (path === '/runner/credentials/lock' && slept.length === 2) {
        service.locks.delete('bob/claude-code')
        service.put('bob', 'claude-code', { version: 2, method: 'login', material: { files: { '.credentials.json': claudeFile('refreshed', soon + 3_600_000) } }, expiresAt: soon + 3_600_000 })
      }
      return originalCall(path, body, schema)
    }
    const seat = await seats.resolveForTurn('bob', 'claude-code')
    expect(slept).toEqual([2_000, 2_000])
    expect(service.paths()).toEqual(['lease', 'lock', 'lock', 'lock', 'lease'])
    expect(readFileSync(join(bobHome, '.credentials.json'), 'utf8')).toBe(claudeFile('refreshed', soon + 3_600_000))
    // This runner took the lock once the holder let go, so it releases it after the turn.
    await seat!.release!()
    expect(service.paths().at(-1)).toBe('unlock')
  })

  test('a lock that lapses without a release is not waited on past its expiry; the turn proceeds unlocked', async () => {
    const { seats, service, slept } = harness()
    const soon = service.now() + 60_000
    service.put('bob', 'claude-code', { version: 1, method: 'login', material: { files: { '.credentials.json': claudeFile('v1', soon) } }, expiresAt: soon })
    const holderExpiresAt = service.now() + 3_000
    const originalCall = service.call.bind(service)
    // The holder never releases, and the fake service keeps answering that it holds it until then.
    service.call = async (path, body, schema) => {
      if (path === '/runner/credentials/lock') {
        service.calls.push({ path, body })
        return { kind: 'ok', body: schema.parse({ acquired: false, expiresAt: holderExpiresAt }) }
      }
      return originalCall(path, body, schema)
    }
    const seat = await seats.resolveForTurn('bob', 'claude-code')
    expect(slept).toEqual([2_000, 1_000])
    expect(service.paths()).toEqual(['lease', 'lock', 'lock', 'lock', 'lease'])
    await seat!.release!()
    expect(service.paths().at(-1)).not.toBe('unlock')
  })

  test('when the service cannot be asked, a credential leased earlier still runs the turn; with none, the turn is refused', async () => {
    const { seats, service } = harness()
    service.offline = true
    await expect(seats.resolveForTurn('bob', 'claude-code')).rejects.toThrow(SeatRequiredError)
    service.offline = false
    service.put('bob', 'claude-code', { version: 1, method: 'login', material: { files: { '.credentials.json': claudeFile('v1') } }, expiresAt: 1_800_000_000_000 })
    await seats.resolveForTurn('bob', 'claude-code')
    service.offline = true
    expect((await seats.resolveForTurn('bob', 'claude-code'))?.home).toContain('bob')
  })
})
