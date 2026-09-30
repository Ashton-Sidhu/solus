import { describe, expect, test } from 'bun:test'
import type { PresenceFocus } from '@solus/contracts/presence'
import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta } from '@solus/contracts/types'
import type { SidebarSessionChild } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import type { PresencePerson } from '@solus/workspace-ui/components/presence/lib/presence-people'
import type { PickerEntry } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'
import { peopleOnSessions, pickerRowSessions } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-presence'

// The Cmd+P picker says who is working on what: a session row shows the people
// whose screen shows that session, and a task row shows everyone in any of its
// sessions, so a closed task still names who is under it.

const task = { id: 't1' } as Task
const child = (serverId: string | undefined, sessionId: string | undefined) => ({ serverId, sessionId }) as SidebarSessionChild

function person(userId: string, isComposing = false): PresencePerson {
  return { user: { id: { kind: 'account', accountId: userId }, displayName: userId }, userId, displayName: userId, isComposing, deviceCount: 1, clientIds: [`c-${userId}`] }
}

// Host rooms keyed by `serverId|sessionId`, as the presence store answers them.
function roster(rooms: Record<string, PresencePerson[]>) {
  return (serverId: string, focus: PresenceFocus) => focus.kind === 'session' ? rooms[`${serverId}|${focus.sessionId}`] ?? [] : []
}

describe('picker presence', () => {
  test('a task row stands for every session under it that has a room', () => {
    const row: PickerEntry = { kind: 'task', key: 'task:t1', entryIndex: 0, task, sessions: [child('h1', 's1'), child('h2', 's2'), child('h1', undefined)], expanded: false }
    expect(pickerRowSessions(row)).toEqual([{ serverId: 'h1', sessionId: 's1' }, { serverId: 'h2', sessionId: 's2' }])
  })

  test('a session row stands for its session, and a conversation row for the host its hit came from', () => {
    const session: PickerEntry = { kind: 'session', key: 'session:s1', entryIndex: 1, task, session: child('h1', 's1'), nested: true, isLast: true }
    expect(pickerRowSessions(session)).toEqual([{ serverId: 'h1', sessionId: 's1' }])
    const meta = { sessionId: 's9', serverId: 'h1' } as SessionMeta
    const hit = { messageId: 1, snippet: '', ts: 0, rank: 0 }
    expect(pickerRowSessions({ kind: 'conversation', key: 'c', entryIndex: 2, meta, hit, hitServerId: 'h3' })).toEqual([{ serverId: 'h3', sessionId: 's9' }])
    expect(pickerRowSessions({ kind: 'conversation', key: 'c', entryIndex: 2, meta: { sessionId: 's9' } as SessionMeta, hit })).toEqual([])
  })

  test('a person in two of a task\'s sessions is one face', () => {
    const people = peopleOnSessions(
      [{ serverId: 'h1', sessionId: 's1' }, { serverId: 'h1', sessionId: 's2' }],
      roster({ 'h1|s1': [person('bob'), person('maya')], 'h1|s2': [person('bob')] }),
    )
    expect(people.map((p) => p.userId)).toEqual(['bob', 'maya'])
  })

  test('the picker shows who is working where, never who is typing', () => {
    const people = peopleOnSessions([{ serverId: 'h1', sessionId: 's1' }], roster({ 'h1|s1': [person('bob', true)] }))
    expect(people.map((p) => [p.userId, p.isComposing])).toEqual([['bob', false]])
  })

  test('nobody in any session means no faces', () => {
    expect(peopleOnSessions([{ serverId: 'h1', sessionId: 's1' }], roster({}))).toEqual([])
  })
})
