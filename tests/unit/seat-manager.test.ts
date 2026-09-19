import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SEAT_IDLE_REMOVAL_MS, SeatManager, SeatRequiredError, seatUserFor, turnActorFor } from '@solus/server/seats/seat-manager'
import type { Principal } from '@solus/server/server/principal'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import type { SeatChangedEvent } from '@solus/contracts/seats'

// Step 2 plan §3: a member's seat is a directory holding their own credential and a
// link to the host's transcripts; the host owner runs on the host's login; no seat,
// no turn; removal deletes the files; the sweep forgets idle members.

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const REMOTE_OWNER: Principal = { kind: 'remote-owner', userId: 'alice', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const BOB: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd2', expiresAt: 0, deviceLabel: 'Solus cloud' }
const GUEST_OF_BOB: Principal = { kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', share: { resource: { kind: 'session', id: 's1' }, role: 'editor', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function manager(now = () => 1_000_000, hostLoginConnected = async () => true) {
  const root = mkdtempSync(join(tmpdir(), 'seat-manager-'))
  roots.push(root)
  // bun has no node:sqlite; its own Database speaks the same prepare/get/all/run/exec surface.
  const db = new Database(':memory:') as unknown as DatabaseSync
  const events: SeatChangedEvent[] = []
  const seats = new SeatManager({
    db,
    seatsRoot: join(root, 'seats'),
    hostClaudeDir: join(root, 'home', '.claude'),
    hostCodexHome: join(root, 'home', '.codex'),
    hostLoginConnected,
    now,
  })
  seats.onChanged((event) => events.push(event))
  return { seats, events, root }
}

describe('whose seat a prompt runs on', () => {
  test('the owner and the host run on the host login; a member on their own; a guest on the sharer\'s', async () => {
    expect(seatUserFor(OWNER)).toBe(HOST_OWNER_USER_ID)
    expect(seatUserFor(REMOTE_OWNER)).toBe(HOST_OWNER_USER_ID)
    expect(seatUserFor({ kind: 'system' })).toBe(HOST_OWNER_USER_ID)
    expect(seatUserFor(BOB)).toBe('bob')
    expect(seatUserFor(GUEST_OF_BOB)).toBe('bob')
    // The ledger still names the guest as the author; the room and the transcript
    // get the name the principal carries.
    expect(turnActorFor(GUEST_OF_BOB)).toEqual({ userId: 'guest:g1', seatUserId: 'bob', displayName: GUEST_OF_BOB.kind === 'guest' ? GUEST_OF_BOB.displayName : '' })
    expect(turnActorFor(BOB)).toEqual({ userId: 'bob', seatUserId: 'bob', displayName: BOB.kind === 'org-member' ? BOB.displayName : '' })
    expect(turnActorFor(OWNER)).toEqual({ userId: HOST_OWNER_USER_ID, seatUserId: HOST_OWNER_USER_ID, displayName: 'Host owner' })
  })
})

describe('layout', () => {
  test('a seat is a private directory whose transcripts link into the host\'s own provider home', async () => {
    const { seats, root } = manager()
    const claudeHome = seats.homeFor('bob', 'claude-code')
    const codexHome = seats.homeFor('bob', 'codex')
    expect(claudeHome).toBe(join(root, 'seats', 'claude', 'bob'))
    expect(statSync(claudeHome).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'seats')).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(claudeHome, 'projects')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(claudeHome, 'projects'))).toBe(join(root, 'home', '.claude', 'projects'))
    expect(readlinkSync(join(codexHome, 'sessions'))).toBe(join(root, 'home', '.codex', 'sessions'))
    // The link target exists even on a host that never ran the provider, so the first turn can write.
    expect(existsSync(join(root, 'home', '.claude', 'projects'))).toBe(true)
    // The browser shim fails on purpose: a relayed login must print its URL, not open the host's browser.
    const shim = join(seats.shimBinDir(), 'open')
    expect(readFileSync(shim, 'utf8')).toContain('exit 1')
    expect(statSync(shim).mode & 0o100).toBe(0o100)
  })

  test('a user id that could walk the filesystem is refused', async () => {
    const { seats } = manager()
    expect(() => seats.homeFor('../etc', 'claude-code')).toThrow()
    expect(() => seats.homeFor('bob/../alice', 'codex')).toThrow()
  })
})

describe('the host login is the owner\'s seat', () => {
  test('it lives in the host\'s own provider homes, reports what the CLI says, and always resolves', async () => {
    let signedIn = false
    const { seats, root } = manager(undefined, () => signedIn)
    expect(seats.homeFor(HOST_OWNER_USER_ID, 'claude-code')).toBe(join(root, 'home', '.claude'))
    expect(await seats.status(HOST_OWNER_USER_ID, 'codex')).toMatchObject({ state: 'none', hostLogin: true, method: 'login', usageCapable: true })
    signedIn = true
    expect(await seats.status(HOST_OWNER_USER_ID, 'claude-code')).toMatchObject({ state: 'connected', hostLogin: true })
    // No seat directory, no links, no shim: the single-person host is untouched.
    expect(existsSync(join(root, 'seats'))).toBe(false)
    // A missing login is the provider's own error at spawn, as it always was.
    signedIn = false
    expect(seats.resolveForTurn(HOST_OWNER_USER_ID, 'claude-code')).toMatchObject({ userId: HOST_OWNER_USER_ID, home: join(root, 'home', '.claude'), isHostLogin: true })
    expect(seats.resolveForTurn(HOST_OWNER_USER_ID, 'claude-code')?.envToken).toBeUndefined()
  })

  test('a finished CLI login leaves no row behind; a pasted token is Solus\'s to keep and to delete; the home is never removed', async () => {
    const { seats, root } = manager()
    await seats.markConnecting(HOST_OWNER_USER_ID, 'claude-code')
    expect((await seats.status(HOST_OWNER_USER_ID, 'claude-code')).state).toBe('connecting')
    await seats.markConnected(HOST_OWNER_USER_ID, 'claude-code', 'login')
    expect(await seats.status(HOST_OWNER_USER_ID, 'claude-code')).toMatchObject({ state: 'connected', method: 'login', hostLogin: true })
    await seats.storeToken(HOST_OWNER_USER_ID, 'claude-code', 'owner-token')
    expect(seats.resolveForTurn(HOST_OWNER_USER_ID, 'claude-code')).toMatchObject({ isHostLogin: true, envToken: 'owner-token' })
    expect(await seats.status(HOST_OWNER_USER_ID, 'claude-code')).toMatchObject({ method: 'token', usageCapable: false, hostLogin: true })
    await seats.disconnect(HOST_OWNER_USER_ID, 'claude-code')
    expect(existsSync(join(root, 'home', '.claude', 'solus-seat-token'))).toBe(false)
    expect(seats.resolveForTurn(HOST_OWNER_USER_ID, 'claude-code')?.envToken).toBeUndefined()
    await expect(seats.remove(HOST_OWNER_USER_ID)).rejects.toThrow(/host login/)
    expect(existsSync(join(root, 'home', '.claude'))).toBe(true)
  })
})

describe('resolving a turn', () => {
  test('a member with no seat is refused with SEAT_REQUIRED before anything runs; a non-seat provider has none', async () => {
    const { seats } = manager()
    expect(seats.resolveForTurn('bob', 'opencode')).toBeNull()
    let refusal: unknown
    try { seats.resolveForTurn('bob', 'claude-code') } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(SeatRequiredError)
    expect((refusal as SeatRequiredError).code).toBe('SEAT_REQUIRED')
    expect((refusal as SeatRequiredError).state).toBe('none')
  })

  test('a connecting or expired seat is not a seat; a connected one names its directory', async () => {
    const { seats } = manager()
    await seats.markConnecting('bob', 'claude-code')
    expect(() => seats.resolveForTurn('bob', 'claude-code')).toThrow(SeatRequiredError)
    await seats.markConnected('bob', 'claude-code', 'login')
    const seat = seats.resolveForTurn('bob', 'claude-code')
    expect(seat?.home).toBe(seats.homeFor('bob', 'claude-code'))
    expect(seat?.envToken).toBeUndefined()
    expect(await seats.status('bob', 'claude-code')).toMatchObject({ state: 'connected', method: 'login', usageCapable: true })
    await seats.markExpired('bob', 'claude-code', '401 from the provider')
    let refusal: unknown
    try { seats.resolveForTurn('bob', 'claude-code') } catch (error) { refusal = error }
    expect((refusal as SeatRequiredError).state).toBe('expired')
    expect((await seats.status('bob', 'claude-code')).error).toBe('401 from the provider')
  })

  test('a pasted Claude token rides the env for that turn and cannot show usage', async () => {
    const { seats } = manager()
    await seats.storeToken('bob', 'claude-code', 'sk-ant-oat01-test\n')
    const seat = seats.resolveForTurn('bob', 'claude-code')
    expect(seat?.envToken).toBe('sk-ant-oat01-test')
    expect(await seats.status('bob', 'claude-code')).toMatchObject({ state: 'connected', method: 'token', usageCapable: false })
    expect(statSync(join(seat!.home, 'solus-seat-token')).mode & 0o777).toBe(0o600)
  })

  test('a pasted Codex credential must be its auth.json; it lands in the seat home', async () => {
    const { seats } = manager()
    await expect(seats.storeToken('bob', 'codex', 'not json')).rejects.toThrow(/auth\.json/)
    await seats.storeToken('bob', 'codex', '{"tokens":{"access_token":"x"}}')
    const seat = seats.resolveForTurn('bob', 'codex')
    expect(JSON.parse(readFileSync(join(seat!.home, 'auth.json'), 'utf8'))).toEqual({ tokens: { access_token: 'x' } })
    expect((await seats.status('bob', 'codex')).usageCapable).toBe(true)
  })
})

describe('lifecycle', () => {
  test('every change is announced to the member; a failed connect returns to none with the reason', async () => {
    const { seats, events } = manager()
    await seats.markConnecting('bob', 'codex')
    await seats.markFailed('bob', 'codex', 'exited with code 1')
    expect(events.map((event) => event.state)).toEqual(['connecting', 'none'])
    expect(events[1]?.error).toBe('exited with code 1')
    expect((await seats.list('bob')).map((status) => status.state)).toEqual(['none', 'none'])
  })

  test('disconnect deletes the credential and keeps the directory; remove deletes the directory', async () => {
    const { seats } = manager()
    await seats.storeToken('bob', 'codex', '{}')
    const home = seats.homeFor('bob', 'codex')
    expect((await seats.disconnect('bob', 'codex')).state).toBe('none')
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(existsSync(home)).toBe(true)
    await seats.storeToken('bob', 'codex', '{}')
    await seats.storeToken('bob', 'claude-code', 'tok')
    expect(await seats.remove('bob')).toBe(2)
    expect(existsSync(home)).toBe(false)
    expect(existsSync(seats.homeFor('cara', 'codex'))).toBe(true)
  })

  test('the sweep removes member seats nobody ran a turn on for thirty days; running a turn keeps one, and the host login is never swept', async () => {
    let now = 1_000_000
    const { seats } = manager(() => now)
    await seats.storeToken('bob', 'codex', '{}')
    await seats.storeToken('cara', 'codex', '{}')
    await seats.storeToken(HOST_OWNER_USER_ID, 'claude-code', 'owner-token')
    now += SEAT_IDLE_REMOVAL_MS - 1
    seats.resolveForTurn('cara', 'codex')
    now += 2
    expect(await seats.sweep()).toBe(1)
    expect((await seats.status('bob', 'codex')).state).toBe('none')
    expect((await seats.status('cara', 'codex')).state).toBe('connected')
    expect(await seats.status(HOST_OWNER_USER_ID, 'claude-code')).toMatchObject({ state: 'connected', method: 'token' })
  })
})
