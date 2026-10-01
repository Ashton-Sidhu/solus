import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SEAT_IDLE_REMOVAL_MS, SeatManager, SeatRequiredError } from '@solus/server/execution/seats/seat-manager'
import { actorFor, seatFor } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import { hostUserKey, useHostUser } from '@solus/server/host/host-user'
import { MemberFolders, useMemberFolders } from '@solus/server/host/member-folders'
import { HOST_LOGIN_SEAT, type Seat, type SeatChangedEvent } from '@solus/contracts/seats'

/** The key a host wrote for its owner before plan 012 stage 1; old rows and links may still hold it. */
const LEGACY_HOST_OWNER_KEY = 'host-owner'

// Step 2 plan §3 and plans/012-user-actor-and-activity.md §3: a user's seat is a
// directory holding their own credential and a link to the host's transcripts; the
// host's owner runs on the host login, which is a kind of seat and not a user; no
// seat, no turn; removal deletes the files; the sweep forgets idle members.

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const REMOTE_OWNER: Principal = { kind: 'remote-owner', userId: 'alice', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const BOB: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd2', expiresAt: 0, deviceLabel: 'Solus cloud' }
const guestOf = (sharedByUserId: string): Principal => ({ kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', share: { resource: { kind: 'session', id: 's1' }, role: 'editor', sharedByUserId, linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' })
const GUEST_OF_BOB = guestOf('bob')

/** The seat `SolusServer.handle()` resolves for a caller (plans/012 §4). */
const seatOf = (principal: Principal): Seat => seatFor(actorFor(principal))
const userSeat = (accountId: string): Seat => ({ kind: 'user', userId: { kind: 'account', accountId } })
const BOB_SEAT = userSeat('bob')
const CARA_SEAT = userSeat('cara')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  useHostUser(null)
  useMemberFolders(null)
})

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
  return { seats, events, root, db }
}

describe('whose seat a prompt runs on', () => {
  test('the owner and the host run on the host login; a member on their own; a guest on the sharer\'s', async () => {
    expect(seatOf(OWNER)).toEqual(HOST_LOGIN_SEAT)
    expect(seatOf(REMOTE_OWNER)).toEqual(HOST_LOGIN_SEAT)
    expect(seatOf({ kind: 'system' })).toEqual(HOST_LOGIN_SEAT)
    expect(seatOf(BOB)).toEqual({ ...BOB_SEAT, name: 'Bob' })
    expect(seatOf(GUEST_OF_BOB)).toEqual(BOB_SEAT)
  })

  test('the owner runs on the host login whatever key the host\'s user has; a guest of the owner does too', () => {
    // Unlinked (a `local` user), then linked (the owner's account): the owner's key
    // changes, the seat does not. A seat store that compared the owner's key would fail here.
    for (const settings of [{ localId: 'mac-1' }, { localId: 'mac-1', account: { accountId: 'alice' } }]) {
      useHostUser(settings)
      expect(seatOf(OWNER)).toEqual(HOST_LOGIN_SEAT)
      expect(seatOf(REMOTE_OWNER)).toEqual(HOST_LOGIN_SEAT)
      expect(seatOf(guestOf(hostUserKey()))).toEqual(HOST_LOGIN_SEAT)
      // A link shared before the host had a user still names the old owner key.
      expect(seatOf(guestOf(LEGACY_HOST_OWNER_KEY))).toEqual(HOST_LOGIN_SEAT)
      expect(seatOf(BOB)).toEqual({ ...BOB_SEAT, name: 'Bob' })
    }
  })
})

describe('the host login is not a user', () => {
  test('a member whose account id is the old owner sentinel has a seat of their own, not the host login', async () => {
    const { seats } = manager()
    const lookalike = userSeat(LEGACY_HOST_OWNER_KEY)
    await expect(seats.resolveForTurn(lookalike, 'claude-code')).rejects.toThrow(SeatRequiredError)
    expect(await seats.status(lookalike, 'claude-code')).toEqual({ provider: 'claude-code', state: 'none', usageCapable: false })
    await seats.storeToken(HOST_LOGIN_SEAT, 'claude-code', 'owner-token')
    await expect(seats.resolveForTurn(lookalike, 'claude-code')).rejects.toThrow(SeatRequiredError)
  })

  test('the host login\'s row stored under the old owner sentinel reads as the host login', async () => {
    const { seats: first, db, root } = manager()
    // A pasted owner token, as a host before plan 012 stage 2 stored it.
    mkdirSync(join(root, 'home', '.claude'), { recursive: true })
    writeFileSync(join(root, 'home', '.claude', 'solus-seat-token'), 'owner-token\n')
    db.prepare(`INSERT INTO provider_seat (user_id, provider, state, method, error, connected_at, last_used_at, updated_at)
      VALUES (?, 'claude-code', 'connected', 'token', NULL, 5, 5, 5)`).run(LEGACY_HOST_OWNER_KEY)
    // The next start moves it.
    const seats = new SeatManager({ db, seatsRoot: first.seatsRoot, hostClaudeDir: join(root, 'home', '.claude'), hostCodexHome: join(root, 'home', '.codex'), hostLoginConnected: async () => false, now: () => 1_000_000 })
    expect(await seats.status(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ state: 'connected', method: 'token', hostLogin: true, connectedAt: 5 })
    expect(await seats.resolveForTurn(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ seat: HOST_LOGIN_SEAT, envToken: 'owner-token' })
    expect(seats.memberUserIds()).toEqual([])
    expect(await seats.status(userSeat(LEGACY_HOST_OWNER_KEY), 'claude-code')).toMatchObject({ state: 'none' })
    expect(await seats.sweep(0)).toBe(0)
  })
})

describe('layout', () => {
  test('a seat is a private directory whose transcripts link into the host\'s own provider home', async () => {
    const { seats, root } = manager()
    const claudeHome = seats.homeFor(BOB_SEAT, 'claude-code')
    const codexHome = seats.homeFor(BOB_SEAT, 'codex')
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
    expect(() => seats.homeFor(userSeat('../etc'), 'claude-code')).toThrow()
    expect(() => seats.homeFor(userSeat('bob/../alice'), 'codex')).toThrow()
    // A `local` or guest key is never a seat directory.
    expect(() => seats.homeFor({ kind: 'user', userId: { kind: 'local', localId: 'mac-1' } }, 'codex')).toThrow()
  })

  test('a member\'s seats live in their named member folder', async () => {
    const { seats, root, db } = manager()
    useMemberFolders(new MemberFolders({ db, roots: () => [join(root, 'seats', 'claude'), join(root, 'seats', 'codex')] }))
    const ada: Seat = { kind: 'user', userId: { kind: 'account', accountId: 'u1' }, name: 'Ada Lovelace' }
    expect(seats.homeFor(ada, 'claude-code')).toBe(join(root, 'seats', 'claude', 'ada-lovelace'))
    expect(seats.homeFor(ada, 'codex')).toBe(join(root, 'seats', 'codex', 'ada-lovelace'))
    // A call that does not know the name finds the same folder.
    await seats.storeToken(userSeat('u1'), 'claude-code', 'tok')
    expect(readFileSync(join(root, 'seats', 'claude', 'ada-lovelace', 'solus-seat-token'), 'utf8')).toBe('tok\n')
    expect(await seats.remove({ kind: 'account', accountId: 'u1' })).toBe(1)
    expect(existsSync(join(root, 'seats', 'claude', 'ada-lovelace'))).toBe(false)
  })
})

describe('the host login is the owner\'s seat', () => {
  test('it lives in the host\'s own provider homes, reports what the CLI says, and always resolves', async () => {
    let signedIn = false
    const { seats, root } = manager(undefined, () => signedIn)
    expect(seats.homeFor(HOST_LOGIN_SEAT, 'claude-code')).toBe(join(root, 'home', '.claude'))
    expect(await seats.status(HOST_LOGIN_SEAT, 'codex')).toMatchObject({ state: 'none', hostLogin: true, method: 'login', usageCapable: true })
    signedIn = true
    expect(await seats.status(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ state: 'connected', hostLogin: true })
    // No seat directory, no links, no shim: the single-person host is untouched.
    expect(existsSync(join(root, 'seats'))).toBe(false)
    // A missing login is the provider's own error at spawn, as it always was.
    signedIn = false
    expect(await seats.resolveForTurn(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ seat: HOST_LOGIN_SEAT, home: join(root, 'home', '.claude') })
    expect((await seats.resolveForTurn(HOST_LOGIN_SEAT, 'claude-code'))?.envToken).toBeUndefined()
  })

  test('a finished CLI login leaves no row behind; a pasted token is Solus\'s to keep and to delete; the home is never removed', async () => {
    const { seats, root } = manager()
    await seats.markConnecting(HOST_LOGIN_SEAT, 'claude-code')
    expect((await seats.status(HOST_LOGIN_SEAT, 'claude-code')).state).toBe('connecting')
    await seats.markConnected(HOST_LOGIN_SEAT, 'claude-code', 'login')
    expect(await seats.status(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ state: 'connected', method: 'login', hostLogin: true })
    await seats.storeToken(HOST_LOGIN_SEAT, 'claude-code', 'owner-token')
    expect(await seats.resolveForTurn(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ seat: HOST_LOGIN_SEAT, envToken: 'owner-token' })
    expect(await seats.status(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ method: 'token', usageCapable: false, hostLogin: true })
    await seats.disconnect(HOST_LOGIN_SEAT, 'claude-code')
    expect(existsSync(join(root, 'home', '.claude', 'solus-seat-token'))).toBe(false)
    expect((await seats.resolveForTurn(HOST_LOGIN_SEAT, 'claude-code'))?.envToken).toBeUndefined()
    expect(existsSync(join(root, 'home', '.claude'))).toBe(true)
  })
})

describe('resolving a turn', () => {
  test('a member with no seat is refused with SEAT_REQUIRED before anything runs; a non-seat provider has none', async () => {
    const { seats } = manager()
    expect(await seats.resolveForTurn(BOB_SEAT, 'opencode')).toBeNull()
    let refusal: unknown
    try { await seats.resolveForTurn(BOB_SEAT, 'claude-code') } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(SeatRequiredError)
    expect((refusal as SeatRequiredError).code).toBe('SEAT_REQUIRED')
    expect((refusal as SeatRequiredError).state).toBe('none')
  })

  test('a connecting or expired seat is not a seat; a connected one names its directory', async () => {
    const { seats } = manager()
    await seats.markConnecting(BOB_SEAT, 'claude-code')
    await expect(seats.resolveForTurn(BOB_SEAT, 'claude-code')).rejects.toThrow(SeatRequiredError)
    await seats.markConnected(BOB_SEAT, 'claude-code', 'login')
    const seat = await seats.resolveForTurn(BOB_SEAT, 'claude-code')
    expect(seat?.home).toBe(seats.homeFor(BOB_SEAT, 'claude-code'))
    expect(seat?.envToken).toBeUndefined()
    expect(await seats.status(BOB_SEAT, 'claude-code')).toMatchObject({ state: 'connected', method: 'login', usageCapable: true })
    await seats.markExpired(BOB_SEAT, 'claude-code', '401 from the provider')
    let refusal: unknown
    try { await seats.resolveForTurn(BOB_SEAT, 'claude-code') } catch (error) { refusal = error }
    expect((refusal as SeatRequiredError).state).toBe('expired')
    expect((await seats.status(BOB_SEAT, 'claude-code')).error).toBe('401 from the provider')
  })

  test('a pasted Claude token rides the env for that turn and cannot show usage', async () => {
    const { seats } = manager()
    await seats.storeToken(BOB_SEAT, 'claude-code', 'sk-ant-oat01-test\n')
    const seat = await seats.resolveForTurn(BOB_SEAT, 'claude-code')
    expect(seat?.envToken).toBe('sk-ant-oat01-test')
    expect(await seats.status(BOB_SEAT, 'claude-code')).toMatchObject({ state: 'connected', method: 'token', usageCapable: false })
    expect(statSync(join(seat!.home, 'solus-seat-token')).mode & 0o777).toBe(0o600)
  })

  test('a pasted Codex credential must be its auth.json; it lands in the seat home', async () => {
    const { seats } = manager()
    await expect(seats.storeToken(BOB_SEAT, 'codex', 'not json')).rejects.toThrow(/auth\.json/)
    await seats.storeToken(BOB_SEAT, 'codex', '{"tokens":{"access_token":"x"}}')
    const seat = await seats.resolveForTurn(BOB_SEAT, 'codex')
    expect(JSON.parse(readFileSync(join(seat!.home, 'auth.json'), 'utf8'))).toEqual({ tokens: { access_token: 'x' } })
    expect((await seats.status(BOB_SEAT, 'codex')).usageCapable).toBe(true)
  })
})

describe('lifecycle', () => {
  test('every change is announced to the member; a failed connect returns to none with the reason', async () => {
    const { seats, events } = manager()
    await seats.markConnecting(BOB_SEAT, 'codex')
    await seats.markFailed(BOB_SEAT, 'codex', 'exited with code 1')
    expect(events.map((event) => event.state)).toEqual(['connecting', 'none'])
    expect(events[1]?.error).toBe('exited with code 1')
    expect((await seats.list(BOB_SEAT)).map((status) => status.state)).toEqual(['none', 'none'])
  })

  test('disconnect deletes the credential and keeps the directory; remove deletes the directory', async () => {
    const { seats } = manager()
    await seats.storeToken(BOB_SEAT, 'codex', '{}')
    const home = seats.homeFor(BOB_SEAT, 'codex')
    expect((await seats.disconnect(BOB_SEAT, 'codex')).state).toBe('none')
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(existsSync(home)).toBe(true)
    await seats.storeToken(BOB_SEAT, 'codex', '{}')
    await seats.storeToken(BOB_SEAT, 'claude-code', 'tok')
    expect(await seats.remove({ kind: 'account', accountId: 'bob' })).toBe(2)
    expect(existsSync(home)).toBe(false)
    expect(existsSync(seats.homeFor(CARA_SEAT, 'codex'))).toBe(true)
  })

  test('the sweep removes member seats nobody ran a turn on for thirty days; running a turn keeps one, and the host login is never swept', async () => {
    let now = 1_000_000
    const { seats } = manager(() => now)
    await seats.storeToken(BOB_SEAT, 'codex', '{}')
    await seats.storeToken(CARA_SEAT, 'codex', '{}')
    await seats.storeToken(HOST_LOGIN_SEAT, 'claude-code', 'owner-token')
    now += SEAT_IDLE_REMOVAL_MS - 1
    await seats.resolveForTurn(CARA_SEAT, 'codex')
    now += 2
    expect(await seats.sweep()).toBe(1)
    expect((await seats.status(BOB_SEAT, 'codex')).state).toBe('none')
    expect((await seats.status(CARA_SEAT, 'codex')).state).toBe('connected')
    expect(await seats.status(HOST_LOGIN_SEAT, 'claude-code')).toMatchObject({ state: 'connected', method: 'token' })
  })
})
