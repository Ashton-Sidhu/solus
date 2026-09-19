import { describe, expect, test } from 'bun:test'
import type { HostParticipant, SessionParticipant } from '@solus/contracts/presence'
import { activeTurnAuthorOf, activityWords, composingLabel, followStep, newArrivals, peopleFocusedOn, peopleFrom, presenceTint, stackPeople } from '@solus/workspace-ui/components/presence/lib/presence-people'
import { focusLabel, hostPeopleAcrossHosts, primaryPresence, rosterPeople, rosterWhere, sessionLabelIn, whereIs, type HostPerson } from '@solus/workspace-ui/components/presence/lib/host-people'
import type { Session } from '@solus/contracts/types'

// docs/plans/multiplayer-presence.md §3: a stack shows people, not sockets; the
// reader is never in their own stack, whichever door each of their clients came
// through; the same person across hosts is one face; and the words for a room
// follow the count.

function participant(clientId: string, userId: string, extra: Partial<SessionParticipant & HostParticipant> = {}): SessionParticipant & HostParticipant {
  return { clientId, userId, displayName: userId[0]!.toUpperCase() + userId.slice(1), colorIndex: 1, deviceLabel: 'Web', access: 'member', joinedAt: 0, isComposing: false, focus: { kind: 'none' }, ...extra }
}

const nobody = { self: [] }
const as = (...self: string[]) => ({ self })

describe('people from participants', () => {
  test('the same person on two devices is one face with two devices; the reader is left out', () => {
    const people = peopleFrom([
      participant('c1', 'alice', { joinedAt: 2 }),
      participant('c2', 'bob', { joinedAt: 1, isComposing: true }),
      participant('c3', 'bob', { joinedAt: 3, deviceLabel: 'Solus cloud' }),
    ], as('alice'))
    expect(people.map((person) => person.userId)).toEqual(['bob'])
    expect(people[0]).toMatchObject({ displayName: 'Bob', initials: 'BO', isComposing: true, deviceCount: 2, clientIds: ['c2', 'c3'] })
  })

  test('the reader is left out under every id that is theirs on the host', () => {
    // WHY: the desktop reaches its own machine as `host-owner` and the browser
    // reaches it as the account; both are the reader, and neither is a teammate.
    const people = peopleFrom([
      participant('c1', 'host-owner', { displayName: 'Host owner' }),
      participant('c2', 'user_ashton'),
      participant('c3', 'bob'),
    ], as('host-owner', 'user_ashton'))
    expect(people.map((person) => person.userId)).toEqual(['bob'])
  })

  test('a shared machine names its owner by the account the directory knows, not "Host owner"', () => {
    const [owner] = peopleFrom([participant('c1', 'host-owner', { displayName: 'Host owner' })], { self: ['bob'], hostOwnerName: 'Ashton Sidhu' })
    expect(owner).toMatchObject({ displayName: 'Ashton Sidhu', initials: 'AS' })
    const [unnamed] = peopleFrom([participant('c1', 'host-owner', { displayName: 'Host owner' })], as('bob'))
    expect(unnamed?.displayName).toBe('Host owner')
  })

  test('arrival order holds so a stack does not reshuffle', () => {
    const people = peopleFrom([participant('c1', 'cara', { joinedAt: 5 }), participant('c2', 'bob', { joinedAt: 1 })], nobody)
    expect(people.map((person) => person.userId)).toEqual(['bob', 'cara'])
  })

  test('the sidebar finds who is on one session from the host roster', () => {
    const people = peopleFrom([
      participant('c1', 'bob', { focus: { kind: 'session', sessionId: 's1' } }),
      participant('c2', 'cara', { focus: { kind: 'work', workId: 'w1' } }),
    ], nobody)
    expect(peopleFocusedOn(people, { kind: 'session', sessionId: 's1' }).map((person) => person.userId)).toEqual(['bob'])
    expect(peopleFocusedOn(people, { kind: 'work', workId: 'w1' }).map((person) => person.userId)).toEqual(['cara'])
    expect(peopleFocusedOn(people, { kind: 'session', sessionId: 's2' })).toEqual([])
  })
})

describe('words', () => {
  test('the typing line names one, two, or a count', () => {
    const bob = peopleFrom([participant('c1', 'bob', { isComposing: true })], nobody)
    const both = peopleFrom([participant('c1', 'bob', { isComposing: true }), participant('c2', 'cara', { isComposing: true, joinedAt: 1 })], nobody)
    const three = [...both, ...peopleFrom([participant('c3', 'dan', { isComposing: true })], nobody)]
    expect(composingLabel([])).toBeNull()
    expect(composingLabel(peopleFrom([participant('c1', 'bob')], nobody))).toBeNull()
    expect(composingLabel(bob)).toBe('Bob is typing…')
    expect(composingLabel(both)).toBe('Bob and Cara are typing…')
    expect(composingLabel(three)).toBe('3 people are typing…')
  })

  test('a stack shows a few and counts the rest', () => {
    const people = peopleFrom(['a', 'b', 'c', 'd', 'e'].map((id, index) => participant(`c${index}`, id, { joinedAt: index })), nobody)
    expect(stackPeople(people, 3)).toMatchObject({ overflow: 2 })
    expect(stackPeople(people, 3).shown.map((person) => person.userId)).toEqual(['a', 'b', 'c'])
    expect(stackPeople(people, 5).overflow).toBe(0)
  })

  test('where a person is reads by name, or admits it does not know', () => {
    const names = { sessionLabel: (id: string) => (id === 's1' ? 'Fix login' : null), workLabel: () => 'Roadmap' }
    expect(focusLabel({ kind: 'session', sessionId: 's1' }, names)).toBe('In Fix login')
    expect(focusLabel({ kind: 'session', sessionId: 's9' }, names)).toBe('In a session')
    expect(focusLabel({ kind: 'work', workId: 'w1' }, names)).toBe('In Roadmap')
    expect(focusLabel({ kind: 'none' }, names)).toBe('Not in a session')
    expect(focusLabel(undefined, names)).toBe('Not in a session')
  })

  test('the host\'s description names the session and says what its agent does, on a client that never opened it', () => {
    // WHY: "what are my teammates working on" has to read the same everywhere;
    // the sidebar only knows sessions this client has, the host knows them all.
    const names = { sessionLabel: (id: string) => (id === 's1' ? 'Stale local name' : null), workLabel: () => null }
    const activity = (state: 'idle' | 'running' | 'waiting', title: string | null = 'Fix login') => ({ sessionId: 's9', title, taskId: 't1', state, activeTurn: null })
    expect(focusLabel({ kind: 'session', sessionId: 's9' }, names, activity('idle'))).toBe('In Fix login')
    expect(focusLabel({ kind: 'session', sessionId: 's9' }, names, activity('running'))).toBe('In Fix login, agent running')
    expect(focusLabel({ kind: 'session', sessionId: 's9' }, names, activity('waiting'))).toBe('In Fix login, waiting for input')
    // An unindexed session has no name from the host; this client's own name is the fallback.
    expect(focusLabel({ kind: 'session', sessionId: 's1' }, names, { ...activity('running', null), sessionId: 's1' })).toBe('In Stale local name, agent running')
    expect(focusLabel({ kind: 'session', sessionId: 's9' }, names, activity('running', null))).toBe('In a session, agent running')
    // A description of some other session says nothing about this one.
    expect(focusLabel({ kind: 'session', sessionId: 's1' }, names, activity('running'))).toBe('In Stale local name')
    expect(activityWords(undefined)).toBeNull()
  })

  test('a task row rings the author of the turn running in the session its people have focused', () => {
    const running = { sessionId: 's1', title: 'Fix login', taskId: 't1', state: 'running' as const, activeTurn: { authorUserId: 'cara', authorDisplayName: 'Cara', colorIndex: 2, provider: 'claude-code' as const } }
    const people = peopleFrom([
      participant('c1', 'bob', { focus: { kind: 'session', sessionId: 's1' }, activity: running }),
      participant('c2', 'cara', { focus: { kind: 'session', sessionId: 's1' }, activity: running, joinedAt: 1 }),
    ], nobody)
    expect(people.map((person) => person.activity?.title)).toEqual(['Fix login', 'Fix login'])
    expect(activeTurnAuthorOf(people)).toBe('cara')
    expect(activeTurnAuthorOf(peopleFrom([participant('c1', 'bob', { focus: { kind: 'session', sessionId: 's1' }, activity: { ...running, activeTurn: null } })], nobody))).toBeNull()
    expect(activeTurnAuthorOf(peopleFrom([participant('c1', 'bob')], nobody))).toBeNull()
  })

  test('the host roster spans hosts, one row per person per host', () => {
    const rows = hostPeopleAcrossHosts(['h1', 'h2'], (serverId) => (serverId === 'h1' ? peopleFrom([participant('c1', 'bob')], nobody) : peopleFrom([participant('c2', 'bob'), participant('c3', 'cara')], nobody)))
    expect(rows.map((row) => `${row.serverId}:${row.userId}`)).toEqual(['h1:bob', 'h2:bob', 'h2:cara'])
  })
})

describe('roster', () => {
  const row = (serverId: string, userId: string, extra: Partial<SessionParticipant & HostParticipant> = {}): HostPerson =>
    ({ ...peopleFrom([participant(`${serverId}-${userId}`, userId, extra)], nobody)[0]!, serverId })

  test('the same person on several hosts is one face, reachable on each', () => {
    // WHY: bob on the cloud host and on a shared machine is one teammate. Two rows
    // would say two people are here, and follow would not know which bob is meant.
    const people = rosterPeople([
      row('cloud', 'bob'),
      row('mini', 'bob', { focus: { kind: 'session', sessionId: 's1' }, isComposing: true }),
      row('cloud', 'cara'),
    ], (each) => each.userId)
    expect(people.map((person) => person.userId)).toEqual(['bob', 'cara'])
    expect(people[0]).toMatchObject({ deviceCount: 2, isComposing: true, focus: { kind: 'session', sessionId: 's1' } })
    expect(people[0]!.presences.map((presence) => presence.serverId)).toEqual(['cloud', 'mini'])
    // Where they have something open is where a jump goes.
    expect(primaryPresence(people[0]!).serverId).toBe('mini')
    expect(primaryPresence(people[1]!).serverId).toBe('cloud')
  })

  test('a machine\'s owner and the same account on the cloud are one person; an unnamed owner stays apart', () => {
    const identityOf = (each: HostPerson) => (each.userId === 'host-owner' ? (each.serverId === 'mini' ? 'user_ashton' : `host-owner@${each.serverId}`) : each.userId)
    const people = rosterPeople([row('mini', 'host-owner'), row('cloud', 'user_ashton'), row('other', 'host-owner')], identityOf)
    expect(people.map((person) => [person.userId, person.presences.length])).toEqual([['user_ashton', 2], ['host-owner@other', 1]])
  })

  test('the where-line names the host only when the roster spans several', () => {
    const names = { mountedSessions: [], sidebarSessions: [{ sessionId: 's1', serverId: 'mini', label: 'Fix login' }], workTitle: () => undefined }
    const hostLabel = (serverId: string) => (serverId === 'mini' ? 'Ashton’s Mac mini' : 'Cloud')
    const [bob] = rosterPeople([row('cloud', 'bob'), row('mini', 'bob', { focus: { kind: 'session', sessionId: 's1' } })], (each) => each.userId)
    expect(rosterWhere(bob!, names, true, hostLabel)).toBe('In Fix login · Ashton’s Mac mini')
    expect(rosterWhere(bob!, names, false, hostLabel)).toBe('In Fix login')
  })

  test('the merged person carries the description of the host where they have something open', () => {
    const names = { mountedSessions: [], sidebarSessions: [], workTitle: () => undefined }
    const activity = { sessionId: 's2', title: 'Roadmap sync', taskId: null, state: 'waiting' as const, activeTurn: null }
    const [bob] = rosterPeople([row('cloud', 'bob'), row('mini', 'bob', { focus: { kind: 'session', sessionId: 's2' }, activity })], (each) => each.userId)
    expect(bob?.activity).toBe(activity)
    expect(rosterWhere(bob!, names, true, () => 'Mini')).toBe('In Roadmap sync, waiting for input · Mini')
  })
})

describe('arrivals', () => {
  const snapshot = (...userIds: string[]) => ({ participants: userIds.map((id, index) => participant(`c-${id}-${index}`, id, { joinedAt: index })) })

  test('only a person who was not there before is announced, never the reader on a second device', () => {
    expect(newArrivals(snapshot('alice', 'bob'), snapshot('alice', 'bob', 'cara'), as('alice')).map((person) => person.userId)).toEqual(['cara'])
    expect(newArrivals(snapshot('alice'), snapshot('alice', 'alice'), as('alice'))).toEqual([])
    // A second device of someone already here is not an arrival either.
    expect(newArrivals(snapshot('alice', 'bob'), snapshot('alice', 'bob', 'bob'), as('alice'))).toEqual([])
  })

  test('the first snapshot and an unknown self announce nobody', () => {
    expect(newArrivals(undefined, snapshot('alice', 'bob'), as('alice'))).toEqual([])
    expect(newArrivals(snapshot('alice'), snapshot('alice', 'bob'), nobody)).toEqual([])
  })
})

describe('follow mode', () => {
  const bob = (focus: Parameters<typeof followStep>[0]['mine']['focus'] | undefined) => peopleFrom([participant('c1', 'bob', focus ? { focus } : {})], nobody)[0]!
  const s1 = { kind: 'session', sessionId: 's1' } as const
  const w1 = { kind: 'work', workId: 'w1' } as const

  test('opens where the person is once per move, waits while they have nothing open', () => {
    expect(followStep({ person: bob({ kind: 'none' }), lastOpened: null, mine: { serverId: 'h1', focus: { kind: 'none' } }, serverId: 'h1' })).toEqual({ kind: 'wait' })
    expect(followStep({ person: bob(s1), lastOpened: null, mine: { serverId: null, focus: { kind: 'none' } }, serverId: 'h1' })).toEqual({ kind: 'open', focus: s1 })
    expect(followStep({ person: bob(s1), lastOpened: s1, mine: { serverId: 'h1', focus: s1 }, serverId: 'h1' })).toEqual({ kind: 'hold' })
    expect(followStep({ person: bob(w1), lastOpened: s1, mine: { serverId: 'h1', focus: s1 }, serverId: 'h1' })).toEqual({ kind: 'open', focus: w1 })
  })

  test('ends when the reader opens something of their own, or the person leaves', () => {
    // The tether is not a lock: the reader's own navigation wins.
    expect(followStep({ person: bob(s1), lastOpened: s1, mine: { serverId: 'h1', focus: w1 }, serverId: 'h1' })).toEqual({ kind: 'stop', reason: 'navigated' })
    // The same session id on another host is somewhere else.
    expect(followStep({ person: bob(s1), lastOpened: s1, mine: { serverId: 'h2', focus: s1 }, serverId: 'h1' })).toEqual({ kind: 'stop', reason: 'navigated' })
    expect(followStep({ person: null, lastOpened: s1, mine: { serverId: 'h1', focus: s1 }, serverId: 'h1' })).toEqual({ kind: 'stop', reason: 'left' })
  })
})

describe('roster names', () => {
  test('a session is named from a mounted tab first, then the sidebar, then admitted unknown', () => {
    const mounted = [{ id: 's1', title: 'Fix login', messages: [], run: { serverId: 'h1' } }] as unknown as Session[]
    const names = { mountedSessions: mounted, sidebarSessions: [{ sessionId: 's2', serverId: 'h1', label: 'Roadmap sync' }], workTitle: (id: string) => (id === 'w1' ? 'Roadmap' : undefined) }
    expect(sessionLabelIn(names, 'h1', 's1')).toBe('Fix login')
    expect(sessionLabelIn(names, 'h1', 's2')).toBe('Roadmap sync')
    expect(sessionLabelIn(names, 'h2', 's1')).toBeNull()
    const [cara] = hostPeopleAcrossHosts(['h1'], () => peopleFrom([participant('c1', 'cara', { focus: { kind: 'work', workId: 'w1' } })], nobody))
    expect(whereIs(cara!, names)).toBe('In Roadmap')
  })
})

describe('tint', () => {
  test('every index has its own hue and wraps inside the palette', () => {
    const hues = new Set(Array.from({ length: 8 }, (_, index) => presenceTint(index).color))
    expect(hues.size).toBe(8)
    expect(presenceTint(8).color).toBe(presenceTint(0).color)
    expect(presenceTint(-1).color).toBe(presenceTint(7).color)
  })
})
