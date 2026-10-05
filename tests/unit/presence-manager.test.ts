import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PRESENCE_COLOR_COUNT, sessionActivityStateOf, type SessionActivity, type WorkPresenceSnapshot } from '@solus/contracts/presence'
import { parseUserKey, userColorIndex, userKey } from '@solus/contracts/user'
import { PresenceManager, TYPING_EXPIRY_MS, activeTurnFor } from '@solus/server/presence/presence-manager'
import { actorFor } from '@solus/server/admission/actor'
import { hostUser, useHostUser } from '@solus/server/host/host-user'
import type { Principal } from '@solus/server/admission/principal'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'
import { publishPresenceRoom } from '@solus/server/transport/handlers/presence-handlers'

// A host always holds its user; the Solus API, which has none, admits no owner.
beforeEach(() => useHostUser({ localId: 'owner-1' }))
afterEach(() => useHostUser(null))

// docs/plans/multiplayer-presence.md: the host names every participant from its
// principal; a client is in a session's room only while its socket is up and it
// watches the session; a client composes in at most one session; and a person's
// colour is the same everywhere.

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const BOB: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', avatarUrl: 'https://x/bob.png', deviceId: 'd-bob', expiresAt: 0, deviceLabel: 'Solus cloud' }
const MAYA: Principal = { kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', share: { resource: { kind: 'session', id: 's1' }, role: 'viewer', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }

describe('identity comes from the principal', () => {
  test('owner, member, and guest are named by the host; the host itself is nobody', async () => {
    // WHY (plans/012 §1): the owner is the host's `local` user under a real name, never "Host owner".
    let now = 100
    const presence = new PresenceManager({ now: () => now++ })
    expect(presence.join('c-owner', OWNER, 'Mac')).toBe(true)
    expect(presence.join('c-bob', BOB, 'Solus cloud')).toBe(true)
    expect(presence.join('c-maya', MAYA, 'Guest link')).toBe(true)
    expect(presence.join('c-system', { kind: 'system' }, 'Web')).toBe(false)
    const rows = (await presence.hostSnapshot()).participants
    expect(rows.map((row) => [userKey(row.user.id), row.user.displayName, row.access])).toEqual([
      ['local:owner-1', hostUser()!.displayName, 'owner'],
      ['bob', 'Bob', 'member'],
      ['guest:g1', 'Maya', 'guest'],
    ])
    expect(rows[0]?.user.displayName).not.toBe('')
    expect(rows[1]?.user.avatarUrl).toBe('https://x/bob.png')
    expect(rows.every((row) => row.focus.kind === 'none')).toBe(true)
    // Arrival order is kept so a stack does not reshuffle as people come and go.
    expect(rows.map((row) => row.joinedAt)).toEqual([100, 101, 102])
  })

  test('a reconnect keeps the entry rather than doubling it', async () => {
    const presence = new PresenceManager()
    presence.join('c-bob', BOB, 'Solus cloud')
    presence.setFocus('c-bob', { kind: 'session', sessionId: 's1' })
    expect(presence.join('c-bob', BOB, 'Solus cloud')).toBe(false)
    expect((await presence.hostSnapshot()).participants).toHaveLength(1)
    expect((await presence.hostSnapshot()).participants[0]?.focus).toEqual({ kind: 'session', sessionId: 's1' })
  })

  test('the active turn is its actor\'s user; the host\'s own work is the host\'s user', () => {
    expect(activeTurnFor(actorFor(BOB), 'codex')).toEqual({ author: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob', avatarUrl: 'https://x/bob.png' }, provider: 'codex' })
    expect(activeTurnFor(undefined, 'claude-code')?.author).toEqual(hostUser()!)
  })

})

describe('rooms', () => {
  test('a session room is the connected watchers; a dropped socket leaves it at once', async () => {
    const presence = new PresenceManager()
    presence.join('c-owner', OWNER, 'Mac')
    presence.join('c-bob', BOB, 'Solus cloud')
    const watchers = ['c-owner', 'c-bob', 'c-gone']
    expect(presence.sessionSnapshot('s1', watchers, null).participants.map((row) => row.clientId)).toEqual(['c-owner', 'c-bob'])
    presence.leave('c-bob')
    expect(presence.sessionSnapshot('s1', watchers, null).participants.map((row) => row.clientId)).toEqual(['c-owner'])
    expect((await presence.hostSnapshot()).participants).toHaveLength(1)
  })

  test('focus changes report only when they differ', async () => {
    const presence = new PresenceManager()
    presence.join('c-bob', BOB, 'Solus cloud')
    expect(presence.setFocus('c-bob', { kind: 'session', sessionId: 's2' })).toBe(true)
    expect(presence.setFocus('c-bob', { kind: 'session', sessionId: 's2' })).toBe(false)
    expect(presence.setFocus('c-bob', { kind: 'none' })).toBe(true)
    expect(presence.setFocus('c-unknown', { kind: 'none' })).toBe(false)
  })

  test('the roster describes a focused session from the host, and marks a draft only in the focused session', async () => {
    // WHY: a teammate's row must say "In Fix login, agent running" on a client
    // that never opened that session, so the host, not the sidebar, names it.
    const describeSession = (sessionId: string): SessionActivity | null => sessionId === 's1'
      ? { sessionId, title: 'Fix login', taskId: 't1', state: 'running', activeTurn: activeTurnFor(actorFor(BOB), 'claude-code') }
      : null
    const presence = new PresenceManager({ describeSession, schedule: manualClock().schedule })
    presence.join('c-bob', BOB, 'Solus cloud')
    presence.join('c-owner', OWNER, 'Mac')
    presence.setFocus('c-bob', { kind: 'session', sessionId: 's1' })
    presence.setFocus('c-owner', { kind: 'session', sessionId: 's2' })
    presence.setComposing('c-bob', 's2', true)
    const [bob, owner] = (await presence.hostSnapshot()).participants
    expect(bob?.activity).toMatchObject({ title: 'Fix login', taskId: 't1', state: 'running', activeTurn: { author: { displayName: 'Bob' } } })
    expect(bob?.isComposing).toBe(false)
    expect(owner?.activity).toBeUndefined()
    presence.setComposing('c-bob', 's1', true)
    expect((await presence.hostSnapshot()).participants[0]?.isComposing).toBe(true)
    // The handler republishes the host when the draft moves through the focused session.
    expect(presence.focusOf('c-bob')).toEqual({ kind: 'session', sessionId: 's1' })
    expect(presence.focusOf('c-nobody')).toBeUndefined()
    // An unindexed session has no description, and the row simply has none.
    presence.setFocus('c-bob', { kind: 'session', sessionId: 's-unknown' })
    expect((await presence.hostSnapshot()).participants[0]?.activity).toBeUndefined()
    expect(presence.isSessionFocused('s-unknown')).toBe(true)
    expect(presence.isSessionFocused('s1')).toBe(false)
  })

  test('the roster states a status as running, waiting on a person, or resting', () => {
    expect(sessionActivityStateOf('running')).toBe('running')
    expect(sessionActivityStateOf('connecting')).toBe('running')
    expect(sessionActivityStateOf('awaiting_input')).toBe('waiting')
    expect(sessionActivityStateOf('awaiting_plan')).toBe('waiting')
    // A rate-limit pause waits on time, not a person; a settled or unknown session rests.
    expect(sessionActivityStateOf('rate_limited')).toBe('idle')
    expect(sessionActivityStateOf('completed')).toBe('idle')
    expect(sessionActivityStateOf(undefined)).toBe('idle')
  })

  test('a client types in one session; moving to another tells both rooms', () => {
    const presence = new PresenceManager({ schedule: manualClock().schedule })
    presence.join('c-bob', BOB, 'Solus cloud')
    expect(presence.setComposing('c-bob', 's1', true)).toEqual(['s1'])
    expect(presence.setComposing('c-bob', 's1', true)).toEqual([])
    expect(presence.sessionSnapshot('s1', ['c-bob'], null).participants[0]?.isComposing).toBe(true)
    expect(presence.setComposing('c-bob', 's2', true)).toEqual(['s1', 's2'])
    expect(presence.sessionSnapshot('s1', ['c-bob'], null).participants[0]?.isComposing).toBe(false)
    // Ending a draft in a session the client is not composing in changes nothing.
    expect(presence.setComposing('c-bob', 's1', false)).toEqual([])
    expect(presence.setComposing('c-bob', 's2', false)).toEqual(['s2'])
    presence.setComposing('c-bob', 's2', true)
    expect(presence.leave('c-bob')).toEqual({ composingSessionId: 's2' })
  })
})

// A virtual clock for the typing expiry: `advance` runs every timer that falls due.
function manualClock() {
  let now = 0
  let timers: { at: number; run: () => void }[] = []
  return {
    schedule(run: () => void, delayMs: number): () => void {
      const timer = { at: now + delayMs, run }
      timers.push(timer)
      return () => { timers = timers.filter((t) => t !== timer) }
    },
    advance(ms: number): void {
      now += ms
      const due = timers.filter((t) => t.at <= now)
      timers = timers.filter((t) => t.at > now)
      for (const timer of due) timer.run()
    },
  }
}

describe('typing', () => {
  // WHY: "is typing" must mean typing now. A person who stops typing, or whose
  // client never sends a stop, must not show as typing for the rest of the
  // session; each report keeps the mark up, and silence takes it down.
  test('the mark falls when the reports stop, and the rooms are told', () => {
    const clock = manualClock()
    const presence = new PresenceManager({ schedule: clock.schedule })
    const expired: [string, string][] = []
    presence.onComposingExpired((clientId, sessionId) => expired.push([clientId, sessionId]))
    presence.join('c-bob', BOB, 'Solus cloud')
    presence.setComposing('c-bob', 's1', true)
    clock.advance(TYPING_EXPIRY_MS - 1)
    expect(presence.sessionSnapshot('s1', ['c-bob'], null).participants[0]?.isComposing).toBe(true)
    clock.advance(1)
    expect(presence.sessionSnapshot('s1', ['c-bob'], null).participants[0]?.isComposing).toBe(false)
    expect(expired).toEqual([['c-bob', 's1']])
  })

  test('a repeated report keeps the mark up without telling the room again', () => {
    const clock = manualClock()
    const presence = new PresenceManager({ schedule: clock.schedule })
    const expired: string[] = []
    presence.onComposingExpired((_clientId, sessionId) => expired.push(sessionId))
    presence.join('c-bob', BOB, 'Solus cloud')
    expect(presence.setComposing('c-bob', 's1', true)).toEqual(['s1'])
    clock.advance(TYPING_EXPIRY_MS - 1_000)
    expect(presence.setComposing('c-bob', 's1', true)).toEqual([])
    clock.advance(TYPING_EXPIRY_MS - 1_000)
    expect(presence.sessionSnapshot('s1', ['c-bob'], null).participants[0]?.isComposing).toBe(true)
    expect(expired).toEqual([])
  })

  test('an explicit stop, a move to another session, or a disconnect leaves no timer to fire later', () => {
    const clock = manualClock()
    const presence = new PresenceManager({ schedule: clock.schedule })
    const expired: string[] = []
    presence.onComposingExpired((_clientId, sessionId) => expired.push(sessionId))
    presence.join('c-bob', BOB, 'Solus cloud')
    presence.setComposing('c-bob', 's1', true)
    presence.setComposing('c-bob', 's1', false)
    presence.setComposing('c-bob', 's2', true)
    presence.setComposing('c-bob', 's3', true)
    clock.advance(TYPING_EXPIRY_MS)
    // Only the session still marked expires; the stopped and moved-from ones do not.
    expect(expired).toEqual(['s3'])
    presence.setComposing('c-bob', 's3', true)
    presence.leave('c-bob')
    clock.advance(TYPING_EXPIRY_MS)
    expect(expired).toEqual(['s3'])
  })
})

describe('works', () => {
  // WHY (work review plan, phase 3a): the roster and the work's header say who
  // has a work open and who edits it now, by the same rule as typing, so the
  // mark falls on its own when the edits stop.
  test('a work focus is its own place, and editing shows only on the work in focus', async () => {
    const clock = manualClock()
    const presence = new PresenceManager({ schedule: clock.schedule })
    const expired: string[] = []
    presence.onEditingExpired((clientId) => expired.push(clientId))
    presence.join('c-bob', BOB, 'Solus cloud')
    expect(presence.setFocus('c-bob', { kind: 'work', workId: 'w1' })).toBe(true)
    expect(presence.setFocus('c-bob', { kind: 'work', workId: 'w1' })).toBe(false)
    expect(presence.setEditing('c-bob', 'w1', true)).toBe(true)
    expect(presence.setEditing('c-bob', 'w1', true)).toBe(false)
    expect((await presence.hostSnapshot()).participants[0]).toMatchObject({ focus: { kind: 'work', workId: 'w1' }, isEditing: true, isComposing: false })
    presence.setFocus('c-bob', { kind: 'work', workId: 'w2' })
    expect((await presence.hostSnapshot()).participants[0]?.isEditing).toBe(false)
    presence.setFocus('c-bob', { kind: 'work', workId: 'w1' })
    clock.advance(TYPING_EXPIRY_MS)
    expect((await presence.hostSnapshot()).participants[0]?.isEditing).toBe(false)
    expect(expired).toEqual(['c-bob'])
  })

  test('a stop or a disconnect leaves no editing timer to fire later', () => {
    const clock = manualClock()
    const presence = new PresenceManager({ schedule: clock.schedule })
    const expired: string[] = []
    presence.onEditingExpired((clientId) => expired.push(clientId))
    presence.join('c-bob', BOB, 'Solus cloud')
    presence.setEditing('c-bob', 'w1', true)
    expect(presence.setEditing('c-bob', 'w1', false)).toBe(true)
    presence.setEditing('c-bob', 'w1', true)
    presence.leave('c-bob')
    clock.advance(TYPING_EXPIRY_MS)
    expect(expired).toEqual([])
  })
  test('a guest on a work link is told who has that work open, and nothing else of the host', async () => {
    // WHY: people looking at a shared work could not see each other. A guest
    // never gets the host room, so it gets the work's people as the work's room.
    const ana: Principal = { kind: 'guest', guestId: 'g2', displayName: 'Ana', deviceId: 'g2', share: { resource: { kind: 'work', id: 'w1' }, role: 'viewer', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }
    const presence = new PresenceManager()
    presence.join('c-bob', BOB, 'Solus cloud')
    presence.join('c-owner', OWNER, 'Mac')
    presence.join('c-ana', ana, 'Guest link')
    presence.join('c-maya', MAYA, 'Guest link')
    presence.setFocus('c-bob', { kind: 'work', workId: 'w1' })
    presence.setFocus('c-owner', { kind: 'work', workId: 'w2' })
    presence.setFocus('c-ana', { kind: 'work', workId: 'w1' })
    const sent: Array<{ recipients: readonly string[]; type: string; payload: unknown; room?: unknown }> = []
    const events = {
      publish: async (recipients: readonly string[], type: string, payload: unknown) => { sent.push({ recipients, type, payload }); return recipients.length },
      publishToRoom: async (room: unknown, recipients: readonly string[], type: string, payload: unknown) => { sent.push({ room, recipients, type, payload }); return recipients.length },
    } as unknown as HostEventPublisher
    await publishPresenceRoom(presence, events, 'local')
    const workRoom = sent.find((event) => event.type === 'work.presenceChanged') as { recipients: string[]; room: unknown; payload: WorkPresenceSnapshot }
    expect(workRoom.recipients).toEqual(['c-ana'])
    expect(workRoom.room).toEqual({ kind: 'work', id: 'w1' })
    expect(workRoom.payload.participants.map((participant) => participant.clientId)).toEqual(['c-bob', 'c-ana'])
    expect(sent.filter((event) => event.type === 'work.presenceChanged')).toHaveLength(1)
    // A reconnect re-sends the room to that client only.
    sent.length = 0
    await publishPresenceRoom(presence, events, 'local', ['c-bob'])
    expect(sent.map((event) => [event.type, event.recipients])).toEqual([['host.presenceChanged', ['c-bob']]])
  })
})

describe('colour', () => {
  const colourOf = (key: string) => userColorIndex({ id: parseUserKey(key), displayName: 'Anyone' })

  test('is stable per user, inside the palette, and spreads adjacent ids', () => {
    expect(colourOf('bob')).toBe(colourOf('bob'))
    const indexes = ['user-1', 'user-2', 'user-3', 'user-4'].map(colourOf)
    for (const index of indexes) expect(index >= 0 && index < PRESENCE_COLOR_COUNT).toBe(true)
    expect(new Set(indexes).size).toBeGreaterThan(1)
  })

  test('each client computes the colour the host used to send (plans/012 §1)', () => {
    // WHY: `colorIndex` left the wire. These are the indexes the host's
    // `presenceColorIndex` gave before it was deleted; a person keeps their colour
    // across the change, and a name keeps its colour whatever the display name is.
    const before: Record<string, number> = { bob: 4, alice: 7, 'local:5b1f7c1e-0000-4000-8000-000000000001': 1, 'guest:g-42': 5, 'user-1': 4, 'user-2': 5, 'user-3': 2, 'user-4': 3 }
    for (const [key, index] of Object.entries(before)) expect(colourOf(key)).toBe(index)
  })
})
