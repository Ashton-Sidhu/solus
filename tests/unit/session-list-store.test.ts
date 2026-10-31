import { expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE, type SessionState, type SessionView } from '@solus/contracts/session-state'
import type { SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import { SessionListStore } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'
import { sessionPullRequestsStore } from '@solus/workspace-ui/contexts/prs/session-pull-requests.store.svelte'

// This person's session list (docs/plans/session-archive.md). Each session
// carries the settle by its pull requests or task, and the person's own
// settle, archive, and snooze; a change
// arrives with what it leaves, and the client reads nothing back.

const snoozed: SessionView = { ...EMPTY_SESSION_VIEW, snoozedUntil: 100 }
const record = (sessionId: string, fields: Partial<SessionRecord> = {}) =>
  ({ sessionId, title: sessionId, customTitle: null, slug: null, projectRoot: '/repo', projectPath: '-repo', createdAt: 1, organizationId: 'local', state: null, view: null, listed: true, pullRequests: [], ...fields }) as SessionRecord

interface FakeHome { records: SessionRecord[]; events: HostEventSubscriber; lists: Array<SessionRecordListFilter | undefined>; gets: string[]; viewWrites: string[] }

function fakeHomes(homes: Record<string, SessionRecord[]>, runners: Record<string, string> = {}, update?: SolusAPI['sessionUpdate']) {
  const fakes = new Map<string, FakeHome>(Object.entries(homes).map(([serverId, records]) => [serverId, { records, events: new HostEventSubscriber(), lists: [], gets: [], viewWrites: [] }]))
  const apis = new Map([...fakes].map(([serverId, home]) => [serverId, asHostApi({
    sessionRecordList: async (filter) => { home.lists.push(filter); return { records: home.records, indexing: false } },
    sessionRecordGet: async (sessionId) => { home.gets.push(sessionId); return home.records.find((listed) => listed.sessionId === sessionId) ?? null },
    sessionUpdate: update ?? (async (sessionId, change) => {
      home.viewWrites.push(sessionId)
      return { state: UNSETTLED_SESSION_STATE, view: change.archived ? { ...EMPTY_SESSION_VIEW, archivedAt: 5 } : EMPTY_SESSION_VIEW }
    }),
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

test('a session with no project root yet is named by its working folder, never by the provider\'s encoded folder key', async () => {
  // WHY: a chat on a remote host showed "-data-projects-…-solus-chats-<id>" as its project.
  const { store, restore } = fakeHomes({ host: [
    record('chat', { projectRoot: null, cwd: '/data/solus-chats/abc', projectPath: '-data-solus-chats-abc' }),
    record('unknown', { projectRoot: null, cwd: null, projectPath: '-data-repo' }),
  ] })
  try {
    await store.load()
    const byId = new Map(store.sessions.map((listed) => [listed.sessionId, listed.projectPath]))
    expect(byId.get('chat')).toBe('/data/solus-chats/abc')
    expect(byId.get('unknown')).toBeNull()
  } finally { restore() }
})

test('a shared settle and a personal archive each move one session, and nothing is read back', async () => {
  const { store, fakes, announce, restore } = fakeHomes({ host: [record('one'), record('two')] })
  try {
    await store.load()
    announce('host', 'session.stateChanged', 'one', { settledAt: 7, settledBy: 'pull-request' })
    expect(store.stateFor('one')).toMatchObject({ settledAt: 7, archivedAt: null })
    announce('host', 'session.viewChanged', 'two', { ...EMPTY_SESSION_VIEW, archivedAt: 3 })
    expect(store.sessions.map((listed) => listed.sessionId)).toEqual(['one'])
    expect(fakes.get('host')!.lists).toHaveLength(1)
  } finally { restore() }
})

test('settle moves the session before its home answers, and a refusal puts it back', async () => {
  // WHY: the home may be an organization's Solus API a round trip away; the row
  // must not wait for it.
  let refuse = (_error: Error) => {}
  const { store, restore } = fakeHomes({ host: [record('one')] }, {}, () => new Promise((_resolve, reject) => { refuse = reject }))
  try {
    await store.load()
    const settling = store.setSettled({ serverId: 'host', sessionId: 'one' }, true)
    expect(store.stateFor('one')).toMatchObject({ settledBy: 'person' })
    refuse(new Error('refused'))
    await expect(settling).rejects.toThrow('refused')
    expect(store.stateFor('one')).toBeNull()
  } finally { restore() }
})

test("this person's settle is read from their view, and a viewer's unsettle keeps the shared settle", async () => {
  // WHY: a settle is one person's. A teammate's list reads the same session
  // as active, and only an editor may end a settle by the pull requests.
  let answer: Awaited<ReturnType<SolusAPI['sessionUpdate']>> = {}
  const { store, restore } = fakeHomes({ host: [
    record('mine', { view: { ...EMPTY_SESSION_VIEW, settledAt: 4 } }),
    record('merged', { state: { settledAt: 6, settledBy: 'pull-request' } }),
  ] }, {}, async () => answer)
  try {
    await store.load()
    expect(store.stateFor('mine')).toMatchObject({ settledAt: 4, settledBy: 'person' })
    answer = { view: EMPTY_SESSION_VIEW }
    await store.setSettled({ serverId: 'host', sessionId: 'mine' }, false)
    expect(store.stateFor('mine')).toBeNull()
    // The home answers no state: the caller may not end the shared settle.
    await store.setSettled({ serverId: 'host', sessionId: 'merged' }, false)
    expect(store.stateFor('merged')).toMatchObject({ settledAt: 6, settledBy: 'pull-request' })
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

test('a returned session is read on its own, never with the whole list', async () => {
  // WHY: un-archive used to read every page of the home's list for one row.
  const { store, fakes, restore } = fakeHomes({ host: [record('one'), record('two')] })
  try {
    await store.load()
    const two = store.listed('two')
    await store.setArchived({ serverId: 'host', sessionId: 'one' }, true)
    await store.setArchived({ serverId: 'host', sessionId: 'one' }, false)
    await Promise.resolve()
    expect(fakes.get('host')!.lists).toHaveLength(1)
    expect(fakes.get('host')!.gets).toEqual(['one'])
    expect(store.sessions.map((listed) => listed.sessionId).sort()).toEqual(['one', 'two'])
    expect(store.listed('two')).toBe(two)
  } finally { restore() }
})

test('a machine that connects reads its own list and each Solus API, not every machine', async () => {
  // WHY: every connection change used to read every host's whole list. A
  // Solus API's rows open on the machines that ran them, so it is read too.
  const { store, fakes, restore } = fakeHomes({
    'workspace:org-1': [record('on-runner', { organizationId: 'org-1', publication: 'published', runnerHostId: 'vm-b' })],
    'machine-a': [record('a')],
    'machine-b': [record('b')],
  }, { 'vm-b': 'machine-b' })
  try {
    await store.load()
    await store.loadConnected('machine-b')
    expect([...fakes].map(([serverId, home]) => [serverId, home.lists.length])).toEqual([['workspace:org-1', 2], ['machine-a', 1], ['machine-b', 2]])
    expect(store.listed('on-runner')).toMatchObject({ serverId: 'machine-b', runnerOffline: false })
    // A Solus API that connects takes the published sessions every machine listed: every home is read.
    await store.loadConnected('workspace:org-1')
    expect([...fakes].map(([serverId, home]) => [serverId, home.lists.length])).toEqual([['workspace:org-1', 3], ['machine-a', 2], ['machine-b', 3]])
  } finally { restore() }
})

test('the Solus API keeps an organization session; it opens on its machine, and its links come with it', async () => {
  // WHY: the machines that run organization sessions rotate and go offline, so
  // the organization's Solus API keeps their place in the list. A machine's own
  // list and state of such a session do not stand for it.
  const link = { sessionId: 'on-runner', repository: 'github.com/acme/web', number: 1, url: 'https://github.com/acme/web/pull/1', title: 'One', source: 'manual' as const, linkedAt: 1 }
  const { store, fakes, announce, restore } = fakeHomes({
    'workspace:org-1': [
      record('on-runner', { organizationId: 'org-1', publication: 'published', runnerHostId: 'vm-on', view: snoozed, pullRequests: [link] }),
      record('runner-gone', { organizationId: 'org-1', publication: 'published', runnerHostId: 'vm-off' }),
    ],
    runner: [record('on-runner', { organizationId: 'org-1', publication: 'published' }), record('local-only')],
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

test('an organization session that is not published keeps its machine as home, and its snooze stays', async () => {
  // WHY: a session belongs to the window's organization for its Insights alone
  // while its record stays on the machine; the Solus API never lists it. Its
  // snooze once went to the machine but was read from the Solus API, so it
  // came back active on every reload.
  const { store, fakes, restore } = fakeHomes({
    'workspace:org-1': [],
    runner: [record('insights-only', { organizationId: 'org-1', publication: 'local', view: snoozed })],
  })
  try {
    await store.load()
    expect(store.listed('insights-only')).toMatchObject({ serverId: 'runner', homeServerId: 'runner' })
    expect(store.stateFor('insights-only')?.snoozedUntil).toBe(100)

    await store.snooze({ serverId: 'runner', sessionId: 'insights-only', organizationId: 'org-1' }, 200)
    expect(fakes.get('runner')!.viewWrites).toEqual(['insights-only'])
    expect(fakes.get('workspace:org-1')!.viewWrites).toEqual([])

    await store.load()
    expect(store.stateFor('insights-only')?.snoozedUntil).toBe(100)
  } finally { restore() }
})

test('a session no list names finds its home from its organization and publication', async () => {
  const { store, restore } = fakeHomes({ 'workspace:org-1': [], runner: [] })
  try {
    expect(store.homeFor({ serverId: 'runner', sessionId: 'a', organizationId: 'org-1', publication: 'published' })).toBe('workspace:org-1')
    expect(store.homeFor({ serverId: 'runner', sessionId: 'b', organizationId: 'org-1', publication: 'local' })).toBe('runner')
    expect(store.homeFor({ serverId: 'runner', sessionId: 'c', organizationId: 'org-1' })).toBe('runner')
  } finally { restore() }
})

test('switching organizations replaces cached sessions and preserves Local and list state', async () => {
  let organizationId: string | null = 'org-1'
  const { store, fakes, restore } = fakeHomes({
    host: [record('local'), record('legacy', { organizationId: undefined })],
    'workspace:org-1': [record('first', { organizationId: 'org-1', view: snoozed })],
    'workspace:org-2': [record('second', { organizationId: 'org-2' })],
  })
  try {
    await store.load()
    expect(store.sessionsInOrganization(organizationId).map((session) => session.sessionId)).toEqual(['local', 'legacy', 'first'])
    const first = store.listed('first')
    organizationId = 'org-2'
    expect(store.sessionsInOrganization(organizationId).map((session) => session.sessionId)).toEqual(['local', 'legacy', 'second'])
    organizationId = null
    expect(store.sessionsInOrganization(organizationId).map((session) => session.sessionId)).toEqual(['local', 'legacy'])
    organizationId = 'org-1'
    expect(store.sessionsInOrganization(organizationId).map((session) => session.sessionId)).toEqual(['local', 'legacy', 'first'])
    expect(store.listed('first')).toBe(first!)
    expect(store.stateFor('first')?.snoozedUntil).toBe(100)
    expect([...fakes.values()].map((home) => home.lists.length)).toEqual([1, 1, 1])
  } finally { restore() }
})

test("a forgotten host's sessions leave the list; one its Solus API keeps opens from the Solus API", async () => {
  // WHY: a forgotten host's sessions stayed in the sidebar as "Removed host" rows
  // that could not be opened. Forgetting a host takes its sessions with it.
  const runners: Record<string, string> = { 'vm-on': 'runner' }
  const { store, restore } = fakeHomes({
    'workspace:org-1': [record('org-session', { organizationId: 'org-1', publication: 'published', runnerHostId: 'vm-on' })],
    runner: [record('personal')],
    other: [record('elsewhere')],
  }, runners)
  try {
    await store.load()
    delete runners['vm-on']
    store.forgetHost('runner')
    expect(store.listed('personal')).toBeUndefined()
    expect(store.listed('elsewhere')).toBeDefined()
    await Bun.sleep(0)
    expect(store.listed('org-session')).toMatchObject({ serverId: 'workspace:org-1', runnerOffline: true })
  } finally { restore() }
})

test('a listed session keeps what the Workspace page shows of it: its activity, status, branch, owner, and the reader\'s role', async () => {
  const { store, restore } = fakeHomes({
    host: [
      record('shared', { lastActivityAt: 42, status: 'running', branch: 'fix/reconnect', ownerKey: 'account:ada', role: 'editor' }),
      record('own', { lastActivityAt: 7, status: 'idle', branch: null, ownerKey: 'account:me' }),
    ],
  })
  try {
    await store.load()
    expect(store.listed('shared')).toMatchObject({ lastActivityAt: 42, status: 'running', branch: 'fix/reconnect', ownerKey: 'account:ada', role: 'editor' })
    // A host that is the reader's own answers no role, and the row carries none.
    expect(store.listed('own')).toMatchObject({ lastActivityAt: 7, status: 'idle', ownerKey: 'account:me' })
    expect('role' in store.listed('own')!).toBe(false)
  } finally {
    restore()
  }
})
