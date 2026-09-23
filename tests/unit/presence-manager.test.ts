import { describe, expect, test } from 'bun:test'
import { PRESENCE_COLOR_COUNT, sessionActivityStateOf, type SessionActivity } from '@solus/contracts/presence'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { PresenceManager, activeTurnFor, turnAuthorFor, turnAuthorOf } from '@solus/server/presence/presence-manager'
import { presenceColorIndex } from '@solus/server/presence/presence-color'
import type { Principal } from '@solus/server/server/principal'

// docs/plans/multiplayer-presence.md: the host names every participant from its
// principal; a client is in a session's room only while its socket is up and it
// watches the session; a client composes in at most one session; and a person's
// colour is the same everywhere.

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const BOB: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', avatarUrl: 'https://x/bob.png', deviceId: 'd-bob', expiresAt: 0, deviceLabel: 'Solus cloud' }
const MAYA: Principal = { kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', share: { resource: { kind: 'session', id: 's1' }, role: 'viewer', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }

describe('identity comes from the principal', () => {
  test('owner, member, and guest are named by the host; the host itself is nobody', async () => {
    let now = 100
    const presence = new PresenceManager({ now: () => now++ })
    expect(presence.join('c-owner', OWNER, 'Mac')).toBe(true)
    expect(presence.join('c-bob', BOB, 'Solus cloud')).toBe(true)
    expect(presence.join('c-maya', MAYA, 'Guest link')).toBe(true)
    expect(presence.join('c-system', { kind: 'system' }, 'Web')).toBe(false)
    const rows = (await presence.hostSnapshot()).participants
    expect(rows.map((row) => [row.userId, row.displayName, row.access])).toEqual([
      [HOST_OWNER_USER_ID, 'Host owner', 'owner'],
      ['bob', 'Bob', 'member'],
      ['guest:g1', 'Maya', 'guest'],
    ])
    expect(rows[1]?.avatarUrl).toBe('https://x/bob.png')
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

  test('the turn author is the principal, with the same colour the room shows', () => {
    const author = turnAuthorFor(BOB)
    expect(author).toEqual({ userId: 'bob', displayName: 'Bob', avatarUrl: 'https://x/bob.png', colorIndex: presenceColorIndex('bob') })
    expect(turnAuthorFor({ kind: 'system' })).toBeNull()
    expect(activeTurnFor({ userId: 'bob', seatUserId: 'bob', displayName: 'Bob' }, 'codex')).toEqual({
      authorUserId: 'bob', authorDisplayName: 'Bob', colorIndex: presenceColorIndex('bob'), provider: 'codex',
    })
    expect(activeTurnFor(undefined, 'claude-code').authorDisplayName).toBe('Host owner')
  })

  test('a run\'s actor names the bubble and the held prompt alike; the host\'s own work has no name', () => {
    expect(turnAuthorOf({ userId: 'bob', seatUserId: 'bob', displayName: 'Bob', avatarUrl: 'https://x/bob.png' })).toEqual(turnAuthorFor(BOB))
    expect(turnAuthorOf({ userId: HOST_OWNER_USER_ID, seatUserId: HOST_OWNER_USER_ID })).toBeNull()
    expect(turnAuthorOf(undefined)).toBeNull()
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
      ? { sessionId, title: 'Fix login', taskId: 't1', state: 'running', activeTurn: activeTurnFor({ userId: 'bob', seatUserId: 'bob', displayName: 'Bob' }, 'claude-code') }
      : null
    const presence = new PresenceManager({ describeSession })
    presence.join('c-bob', BOB, 'Solus cloud')
    presence.join('c-owner', OWNER, 'Mac')
    presence.setFocus('c-bob', { kind: 'session', sessionId: 's1' })
    presence.setFocus('c-owner', { kind: 'session', sessionId: 's2' })
    presence.setComposing('c-bob', 's2', true)
    const [bob, owner] = (await presence.hostSnapshot()).participants
    expect(bob?.activity).toMatchObject({ title: 'Fix login', taskId: 't1', state: 'running', activeTurn: { authorUserId: 'bob' } })
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

  test('a client composes in one session; moving the draft tells both rooms', () => {
    const presence = new PresenceManager()
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

describe('colour', () => {
  test('is stable per user, inside the palette, and spreads adjacent ids', () => {
    expect(presenceColorIndex('bob')).toBe(presenceColorIndex('bob'))
    const indexes = ['user-1', 'user-2', 'user-3', 'user-4'].map(presenceColorIndex)
    for (const index of indexes) expect(index >= 0 && index < PRESENCE_COLOR_COUNT).toBe(true)
    expect(new Set(indexes).size).toBeGreaterThan(1)
  })
})
