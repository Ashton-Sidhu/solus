import { expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE, type SessionState, type SessionView } from '@solus/contracts/session-state'
import type { SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { SessionListStore } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'
import { sessionPullRequestsStore } from '@solus/workspace-ui/contexts/prs/session-pull-requests.store.svelte'

// This person's session list (docs/plans/session-archive.md). Each session
// carries its shared settle and the person's own archive and snooze; a change
// arrives with what it leaves, and the client reads nothing back.

const snoozed: SessionView = { ...EMPTY_SESSION_VIEW, snoozedUntil: 100 }
const record = (sessionId: string, fields: Partial<SessionRecord> = {}) =>
  ({ sessionId, title: sessionId, customTitle: null, slug: null, projectRoot: '/repo', projectPath: '-repo', createdAt: 1, organizationId: 'local', state: null, view: null, listed: true, pullRequests: [], ...fields }) as SessionRecord

interface FakeHome { records: SessionRecord[]; events: HostEventSubscriber; lists: Array<SessionRecordListFilter | undefined>; viewWrites: string[] }

function fakeHomes(homes: Record<string, SessionRecord[]>, runners: Record<string, string> = {}) {
  const fakes = new Map<string, FakeHome>(Object.entries(homes).map(([serverId, records]) => [serverId, { records, events: new HostEventSubscriber(), lists: [], viewWrites: [] }]))
  const apis = new Map([...fakes].map(([serverId, home]) => [serverId, asHostApi({
    sessionRecordList: async (filter) => { home.lists.push(filter); return { records: home.records, indexing: false } },
    sessionUpdate: async (sessionId, change) => {
      home.viewWrites.push(sessionId)
      return { state: UNSETTLED_SESSION_STATE, view: change.archived ? { ...EMPTY_SESSION_VIEW, archivedAt: 5 } : EMPTY_SESSION_VIEW }
    },
  })]))
  const api = spyOn(serverConnections, 'apiFor').mockImplementation((serverId: string) => apis.get(serverId)!)
  const events = spyOn(serverConnections, 'eventsFor').mockImplementation((serverId: string) => fakes.get(serverId)!.events)
  const store = new SessionListStore({
    connectedRunnerFor: (runnerHostId) => runners[runnerHostId] ?? null,
    connectedServerIds: () => [...fakes.keys()],
  })
  const announce = (serverId: string, type: 'session.stateChanged' | 'session.viewChanged', sessionId: string, value: SessionState | SessionView) =>
    fakes.get(serverId)!.events.receive(type === 'session.stateChanged'
      ? { type, payload: { sessionId, state: value as SessionState }, occurredAt: 1 }
      : { type, payload: { sessionId, view: value as SessionView }, occurredAt: 1 })
  return { store, fakes, announce, restore: () => { api.mockRestore(); events.mockRestore() } }
}

test("reads each home's list for this person, and keeps their snooze across reloads", async () => {
  // WHY: a count limit once made a snoozed session come back active on each
  // reload. Each record carries the person's own view now.
  const { store, fakes, restore } = fakeHomes({ host: [record('asleep', { view: snoozed }), record('active')] })
  try {
    await store.load()
    expect(fakes.get('host')!.lists).toEqual([undefined])
    expect(store.sessions.map((listed) => listed.sessionId).sort()).toEqual(['active', 'asleep'])
    expect(store.stateFor('asleep')?.snoozedUntil).toBe(100)
    expect(store.stateFor('active')).toBeNull()
    await store.load()
    expect(store.stateFor('asleep')?.snoozedUntil).toBe(100)
  } finally { restore() }
})

test('a shared settle and a personal archive each move one session, and nothing is read back', async () => {
  const { store, fakes, announce, restore } = fakeHomes({ host: [record('one'), record('two')] })
  try {
    await store.load()
    announce('host', 'session.stateChanged', 'one', { settledAt: 7, settledBy: 'person' })
    expect(store.stateFor('one')).toMatchObject({ settledAt: 7, archivedAt: null })
    announce('host', 'session.viewChanged', 'two', { ...EMPTY_SESSION_VIEW, archivedAt: 3 })
    expect(store.sessions.map((listed) => listed.sessionId)).toEqual(['one'])
    expect(fakes.get('host')!.lists).toHaveLength(1)
  } finally { restore() }
})

test('archive leaves the list at once, at the session home', async () => {
  const { store, fakes, restore } = fakeHomes({ host: [record('one')] })
  try {
    await store.load()
    await store.setArchived({ serverId: 'host', sessionId: 'one' }, true)
    expect(fakes.get('host')!.viewWrites).toEqual(['one'])
    expect(store.sessions).toEqual([])
    expect(store.stateFor('one')?.archivedAt).toBe(5)
  } finally { restore() }
})

test('the Solus API keeps an organization session; it opens on its machine, and its links come with it', async () => {
  // WHY: the machines that run organization sessions rotate and go offline, so
  // the organization's Solus API keeps their place in the list. A machine's own
  // list and state of such a session do not stand for it.
  const link = { sessionId: 'on-runner', repository: 'github.com/acme/web', number: 1, url: 'https://github.com/acme/web/pull/1', title: 'One', source: 'manual' as const, linkedAt: 1 }
  const { store, fakes, announce, restore } = fakeHomes({
    'workspace:org-1': [
      record('on-runner', { organizationId: 'org-1', runnerHostId: 'vm-on', view: snoozed, pullRequests: [link] }),
      record('runner-gone', { organizationId: 'org-1', runnerHostId: 'vm-off' }),
    ],
    runner: [record('on-runner', { organizationId: 'org-1' }), record('local-only')],
  }, { 'vm-on': 'runner' })
  try {
    await store.load()
    const byId = new Map(store.sessions.map((listed) => [listed.sessionId, listed]))
    expect(byId.get('on-runner')).toMatchObject({ serverId: 'runner', homeServerId: 'workspace:org-1', runnerOffline: false })
    expect(byId.get('runner-gone')).toMatchObject({ serverId: 'workspace:org-1', runnerOffline: true })
    expect(byId.get('local-only')).toMatchObject({ serverId: 'runner', homeServerId: 'runner' })
    expect(store.stateFor('on-runner')?.snoozedUntil).toBe(100)
    expect(sessionPullRequestsStore.linksFor('on-runner')).toEqual([link])

    announce('runner', 'session.viewChanged', 'on-runner', EMPTY_SESSION_VIEW)
    expect(store.stateFor('on-runner')?.snoozedUntil).toBe(100)

    await store.setArchived({ serverId: 'runner', sessionId: 'on-runner' }, true)
    expect(fakes.get('workspace:org-1')!.viewWrites).toEqual(['on-runner'])
    expect(fakes.get('runner')!.viewWrites).toEqual([])
  } finally { restore() }
})
