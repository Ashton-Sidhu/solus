import { expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { ACTIVE_SESSION_STATE, type SessionState } from '@solus/contracts/session-state'
import type { SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { SessionListStore } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'

// The sidebar shows each host's session list (docs/plans/session-archive.md).
// Each session carries its state, and a change arrives with the state it
// leaves: the client writes it and reads nothing back.

const snoozed: SessionState = { ...ACTIVE_SESSION_STATE, snoozedUntil: 100 }
const record = (sessionId: string, state: SessionState | null = null) =>
  ({ sessionId, title: sessionId, customTitle: null, slug: null, projectRoot: '/repo', projectPath: '-repo', createdAt: 1, state }) as SessionRecord

function fakeHost(records: SessionRecord[]) {
  const events = new HostEventSubscriber()
  const lists: Array<SessionRecordListFilter | undefined> = []
  const archived: Array<[string, boolean]> = []
  let refuseArchive = false
  const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
    sessionRecordList: async (filter) => { lists.push(filter); return { records, indexing: false } },
    sessionSetArchived: async (sessionId, isArchived) => {
      if (refuseArchive) throw new Error('refused')
      archived.push([sessionId, isArchived])
      return { ...ACTIVE_SESSION_STATE, archivedAt: isArchived ? 5 : null }
    },
  }))
  const subscription = spyOn(serverConnections, 'eventsFor').mockReturnValue(events)
  const connected = spyOn(serverConnections, 'connectedServerIds').mockReturnValue(['host'])
  const announce = (sessionId: string, state: SessionState) =>
    events.receive({ type: 'session.stateChanged', payload: { sessionId, state }, occurredAt: 1 })
  return {
    lists, archived, announce, setRecords: (next: SessionRecord[]) => { records = next },
    refuseArchive: () => { refuseArchive = true },
    restore: () => { api.mockRestore(); subscription.mockRestore(); connected.mockRestore() },
  }
}

test('reads each host list of sessions not archived, and keeps a snooze across reloads', async () => {
  // WHY: the old shelf read had a limit, and a session missing from it came
  // back active on each reload. The list carries every session's own state.
  const host = fakeHost([record('asleep', snoozed), record('active')])
  const store = new SessionListStore()
  try {
    await store.load()
    expect(host.lists).toEqual([{ archived: false, roots: true }])
    expect(store.sessions.map((listed) => listed.sessionId).sort()).toEqual(['active', 'asleep'])
    expect(store.stateFor('asleep')?.snoozedUntil).toBe(100)
    expect(store.stateFor('active')).toBeNull()

    await store.load()
    expect(store.stateFor('asleep')?.snoozedUntil).toBe(100)
  } finally { host.restore() }
})

test('a state change moves one session, and an archive takes it out of the list', async () => {
  const host = fakeHost([record('one'), record('two')])
  const store = new SessionListStore()
  try {
    await store.load()
    host.announce('one', snoozed)
    expect(store.stateFor('one')?.snoozedUntil).toBe(100)
    expect(store.stateFor('two')).toBeNull()

    host.announce('one', { ...ACTIVE_SESSION_STATE, archivedAt: 3 })
    expect(store.sessions.map((listed) => listed.sessionId)).toEqual(['two'])
    // A session woken on another device is active again.
    host.announce('two', ACTIVE_SESSION_STATE)
    expect(store.stateFor('two')).toBeNull()
    expect(host.lists).toHaveLength(1)
  } finally { host.restore() }
})

test('a session returned to the list that this client does not hold reads the list again', async () => {
  const host = fakeHost([record('one')])
  const store = new SessionListStore()
  try {
    await store.load()
    host.setRecords([record('one'), record('back')])
    host.announce('back', ACTIVE_SESSION_STATE)
    await Promise.resolve()
    expect(host.lists).toHaveLength(2)
  } finally { host.restore() }
})

test('archive leaves the list at once, and comes back when the host refuses', async () => {
  const host = fakeHost([record('one')])
  const store = new SessionListStore()
  try {
    await store.load()
    await store.setArchived({ serverId: 'host', sessionId: 'one' }, true)
    expect(host.archived).toEqual([['one', true]])
    expect(store.sessions).toEqual([])
    expect(store.stateFor('one')?.archivedAt).toBe(5)

    host.setRecords([record('two')])
    await store.load()
    host.refuseArchive()
    await expect(store.setArchived({ serverId: 'host', sessionId: 'two' }, true)).rejects.toThrow('refused')
    expect(store.sessions.map((listed) => listed.sessionId)).toEqual(['two'])
  } finally { host.restore() }
})

test('the Solus API keeps an organization session in the list, and the session opens on its machine', async () => {
  // WHY: the machines that run organization sessions rotate and go offline, so
  // the organization's Solus API keeps their place in the list. A machine's own
  // list or state of such a session must not stand for it, and an archive goes
  // to the API even when the session opens on its machine.
  const orgRecord = (sessionId: string, runnerHostId: string, state: SessionState | null = null) =>
    ({ ...record(sessionId, state), organizationId: 'org-1', runnerHostId }) as SessionRecord
  const lists = new Map<string, SessionRecord[]>([
    ['workspace:org-1', [orgRecord('on-runner', 'vm-on', snoozed), orgRecord('runner-gone', 'vm-off')]],
    ['runner', [orgRecord('on-runner', 'vm-on'), { ...record('local-only'), organizationId: 'local' } as SessionRecord]],
  ])
  const archivedOn: string[] = []
  const events = new Map([['workspace:org-1', new HostEventSubscriber()], ['runner', new HostEventSubscriber()]])
  const apis = new Map([...lists].map(([serverId, records]) => [serverId, asHostApi({
    sessionRecordList: async () => ({ records, indexing: false }),
    sessionSetArchived: async () => { archivedOn.push(serverId); return { ...ACTIVE_SESSION_STATE, archivedAt: 9 } },
  })]))
  const api = spyOn(serverConnections, 'apiFor').mockImplementation((serverId: string) => apis.get(serverId)!)
  const subscription = spyOn(serverConnections, 'eventsFor').mockImplementation((serverId: string) => events.get(serverId)!)
  const connected = spyOn(serverConnections, 'connectedServerIds').mockReturnValue(['workspace:org-1', 'runner'])
  const store = new SessionListStore({
    connectedRunnerFor: (runnerHostId) => runnerHostId === 'vm-on' ? 'runner' : null,
    connectedSolusApiFor: (organizationId) => organizationId === 'org-1' ? 'workspace:org-1' : null,
  })
  try {
    await store.load()
    const byId = new Map(store.sessions.map((listed) => [listed.sessionId, listed]))
    expect(byId.get('on-runner')).toMatchObject({ serverId: 'runner', stateServerId: 'workspace:org-1', runnerOffline: false })
    expect(byId.get('runner-gone')).toMatchObject({ serverId: 'workspace:org-1', stateServerId: 'workspace:org-1', runnerOffline: true })
    expect(byId.get('local-only')).toMatchObject({ serverId: 'runner', stateServerId: 'runner' })
    expect(store.stateFor('on-runner')?.snoozedUntil).toBe(100)

    // The machine's own state of the session does not move it.
    events.get('runner')!.receive({ type: 'session.stateChanged', payload: { sessionId: 'on-runner', state: ACTIVE_SESSION_STATE }, occurredAt: 1 })
    expect(store.stateFor('on-runner')?.snoozedUntil).toBe(100)

    await store.setArchived({ serverId: 'runner', sessionId: 'on-runner' }, true)
    await store.setArchived({ serverId: 'workspace:org-1', sessionId: 'runner-gone' }, true)
    expect(archivedOn).toEqual(['workspace:org-1', 'workspace:org-1'])
    expect(store.sessions.map((listed) => listed.sessionId)).toEqual(['local-only'])
  } finally { api.mockRestore(); subscription.mockRestore(); connected.mockRestore() }
})
