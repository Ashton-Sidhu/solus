import { afterAll, expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { isSolusApiId } from '@solus/contracts/uplink'
import type { SessionRecord } from '@solus/contracts/types'
import type { ListMySessionsResponse, SessionRepositoryFacts } from '@solus/contracts/session-repositories'

// Bun runs the store uncompiled: `$state` is the identity, so an in-place
// write is visible as the same object with a new property value.
const runes = globalThis as unknown as { $state?: unknown }
const previousState = runes.$state
runes.$state = <T>(value: T) => value
afterAll(() => { runes.$state = previousState })
const { SessionListStore } = await import('@solus/workspace-ui/contexts/workspace/session-list.store.svelte')

// The session list with the cloud (docs/plans/portable-sessions-cloud.md §5.5,
// §8.1 E): the records of connected hosts, plus the cloud entries of sessions
// that no connected host has. One row for one session id.

const API = 'workspace:org-1'
const HEAD = 'c'.repeat(40)
const record = (sessionId: string, fields: Partial<SessionRecord> = {}) =>
  ({ sessionId, title: sessionId, customTitle: null, slug: null, projectRoot: '/repo', projectPath: '-repo', createdAt: 1, organizationId: 'local', state: null, view: null, listed: true, pullRequests: [], ...fields }) as SessionRecord
const facts = (fields: Partial<SessionRepositoryFacts> = {}): SessionRepositoryFacts => ({ head: HEAD, syncedTurn: 4, lastRunHostId: 'account-studio', runningHostId: null, ...fields })
const entry = (sessionId: string, fields: Partial<ListMySessionsResponse['items'][number]> = {}): ListMySessionsResponse['items'][number] => ({
  sessionId, title: `cloud ${sessionId}`, provider: 'claude-code', model: 'claude-opus-5-5', repositoryKey: 'github.com/solus-sh/solus', branch: 'main', lastActivityAt: 9, ...facts(), ...fields,
})

/** Homes, the cloud list of the Solus API, and which account hosts are saved or connected here. */
function fakeHomes(opts: { homes: Record<string, SessionRecord[]>; cloud: ListMySessionsResponse['items']; saved?: Record<string, string>; connected?: Record<string, string> }) {
  const events = new Map<string, HostEventSubscriber>()
  const cloudReads: string[] = []
  const serverIds = [...Object.keys(opts.homes), API]
  for (const serverId of serverIds) events.set(serverId, new HostEventSubscriber())
  const apis = new Map(serverIds.map((serverId) => [serverId, asHostApi({
    sessionRecordList: async () => ({ records: opts.homes[serverId] ?? [], indexing: false }),
    sessionRecordGet: async () => null,
    sessionCloudList: async () => { cloudReads.push(serverId); return opts.cloud },
    getSessionInfos: async () => [],
  })]))
  const api = spyOn(serverConnections, 'apiFor').mockImplementation((serverId: string) => apis.get(serverId)!)
  const eventsFor = spyOn(serverConnections, 'eventsFor').mockImplementation((serverId: string) => events.get(serverId)!)
  const connected = { ...opts.connected }
  const store = new SessionListStore({
    connectedRunnerFor: (hostId) => connected[hostId] ?? null,
    savedRunnerFor: (hostId) => opts.saved?.[hostId] ?? connected[hostId] ?? null,
    connectedServerIds: () => serverIds,
    isManagedHost: (serverId) => !isSolusApiId(serverId) && false,
  }, 0, async () => null)
  const headChanged = (sessionId: string, next: SessionRepositoryFacts) =>
    events.get(API)!.receive({ type: 'session.headChanged', payload: { sessionId, ...next }, occurredAt: 1 })
  return { store, cloudReads, headChanged, connected, restore: () => { api.mockRestore(); eventsFor.mockRestore() } }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('a session on two hosts and in the cloud is one row, from a host', async () => {
  // WHY: one row for one session id. A host's record wins over the cloud entry,
  // because the host has the conversation; the cloud adds only its facts.
  const { store, restore } = fakeHomes({
    homes: { mac: [record('moved')], studio: [record('moved')] },
    cloud: [entry('moved')],
    connected: { 'account-studio': 'studio' },
  })
  try {
    await store.load()
    await settle()
    const rows = store.sessions.filter((listed) => listed.sessionId === 'moved')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cloudOnly).toBeUndefined()
    expect(store.cloud.factsFor('moved')).toMatchObject({ head: HEAD, syncedTurn: 4 })
  } finally { restore() }
})

test('a cloud-only entry shows, opens on the saved host that ran it, and names its repository', async () => {
  // WHY: with no host online the person still sees the session and can open it
  // to continue it on another machine (design answer 5.5).
  const { store, restore } = fakeHomes({ homes: { mac: [] }, cloud: [entry('away')], saved: { 'account-studio': 'studio' } })
  try {
    await store.load()
    await settle()
    expect(store.listed('away')).toMatchObject({
      sessionId: 'away', cloudOnly: true, serverId: 'studio', homeServerId: API, runnerOffline: true,
      title: 'cloud away', organizationId: 'local', repositoryKey: 'github.com/solus-sh/solus',
    })
    expect(store.sessionsInOrganization('org-1').map((listed) => listed.sessionId)).toEqual(['away'])
    // The cloud names the host that ran the last turn, so the row says so.
    expect(store.newestHostFor('away', 'mac')).toBe('studio')
  } finally { restore() }
})

test('a cloud entry whose last run host is connected but does not list it shows no row', async () => {
  // WHY: that host archived it; a cloud row would bring an archived session back.
  const { store, restore } = fakeHomes({ homes: { studio: [] }, cloud: [entry('archived')], connected: { 'account-studio': 'studio' } })
  try {
    await store.load()
    await settle()
    expect(store.listed('archived')).toBeUndefined()
    expect(store.sessions).toHaveLength(0)
  } finally { restore() }
})

test('session.headChanged writes the facts in place and does not rebuild the list', async () => {
  // WHY: hundreds of rows read the list; one push must change one property,
  // not every row (packages/workspace-ui/CLAUDE.md, $state rules).
  const { store, headChanged, restore } = fakeHomes({ homes: { mac: [record('local-one')] }, cloud: [entry('away')], saved: { 'account-studio': 'studio' } })
  try {
    await store.load()
    await settle()
    const rowsBefore = store.sessions
    const factsBefore = store.cloud.factsFor('away')
    const next = 'd'.repeat(40)
    headChanged('away', facts({ head: next, syncedTurn: 5 }))
    const factsAfter = store.cloud.factsFor('away')
    expect(factsAfter).toBe(factsBefore!)
    expect(factsAfter).toMatchObject({ head: next, syncedTurn: 5 })
    const rowsAfter = store.sessions
    expect(rowsAfter).toHaveLength(rowsBefore.length)
    rowsAfter.forEach((row, index) => expect(row).toBe(rowsBefore[index]!))
  } finally { restore() }
})

test('a headChanged for a session the client does not know reads the cloud list once', async () => {
  // WHY: the event has no card; a new session pushed from another machine must appear.
  const { store, cloudReads, headChanged, restore } = fakeHomes({ homes: { mac: [] }, cloud: [], saved: {} })
  try {
    await store.load()
    await settle()
    const before = cloudReads.length
    headChanged('new', facts())
    await settle()
    expect(cloudReads.length).toBe(before + 1)
  } finally { restore() }
})

test('sign-out removes cloud-only rows and the cloud facts, so no state stays stale', async () => {
  // WHY: a signed-out client has no cloud; "Not synced yet" or a cloud row after sign-out would lie.
  const { store, restore } = fakeHomes({ homes: { mac: [record('here')] }, cloud: [entry('away'), entry('here', { syncedTurn: 2 })], saved: { 'account-studio': 'studio' } })
  try {
    await store.load()
    await settle()
    store.noteSessionMeta('mac', { sessionId: 'here', head: 'e'.repeat(40), syncedTurn: 3 })
    expect(store.cloudStateFor('here', 'mac')).toEqual({ kind: 'not-synced' })
    store.forgetHost(API)
    expect(store.listed('away')).toBeUndefined()
    expect(store.cloud.factsFor('here')).toBeUndefined()
    expect(store.cloudStateFor('here', 'mac')).toBeNull()
    expect(store.listed('here')?.cloudOnly).toBeUndefined()
  } finally { restore() }
})

test('a turn that ends after a sync from the cloud makes the host newer than the cloud until the push lands', async () => {
  // WHY: "Not synced yet" shows while the turn commit waits for its push, and
  // goes when the cloud reports the same count; it never sticks.
  const { store, headChanged, restore } = fakeHomes({ homes: { mac: [record('here')] }, cloud: [entry('here', { syncedTurn: 4 })] })
  try {
    await store.load()
    await settle()
    store.noteTurnSettled('mac', 'here')
    expect(store.hostTurnsFor('here').of('mac')?.syncedTurn).toBe(5)
    expect(store.cloudStateFor('here', 'mac')).toEqual({ kind: 'not-synced' })
    headChanged('here', facts({ head: 'f'.repeat(40), syncedTurn: 5, lastRunHostId: 'account-mac' }))
    expect(store.cloudStateFor('here', 'mac')).toBeNull()
  } finally { restore() }
})

test('a refused prompt marks the run host, and the newer copy clears it', async () => {
  // WHY: the conversation offers Fork and the newer copy only while this host's turns are out of the session.
  const { store, restore } = fakeHomes({ homes: { mac: [record('here')] }, cloud: [entry('here')], saved: { 'account-studio': 'studio' } })
  try {
    await store.load()
    await settle()
    store.notePushRefused('mac', 'here', true)
    expect(store.cloudStateFor('here', 'mac')).toEqual({ kind: 'push-refused', continuedOnServerId: 'studio', continuedOnHostId: 'account-studio' })
    store.notePushRefused('mac', 'here', false)
    expect(store.cloudStateFor('here', 'mac')?.kind).not.toBe('push-refused')
  } finally { restore() }
})
