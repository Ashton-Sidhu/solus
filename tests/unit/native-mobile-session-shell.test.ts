import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { memoryPullRequestCacheDatabase } from '@solus/client-core/pull-request-cache'
import type { SessionShellChanges, SessionShellCursor, SessionShellOpenRequest, SessionShellOpenResult, SessionShellRow, SessionShellSnapshot } from '@solus/contracts/session-shell'
import type { SessionRecord } from '@solus/contracts/types'
import { SolusApp } from '../../apps/mobile/solus-core/app/solus-app'
import {
  applySessionShellChanges,
  memorySessionShellStore,
  readsSessionShell,
  SessionShells,
  type SessionShellConnection,
  type SessionShellStore,
} from '../../apps/mobile/solus-core/features/threads/session-shell'
import { memoryKeyValueStore, memorySecretStore, type SecretStore } from '../../apps/mobile/solus-core/platform/ports'
import { FakeApi, FakeTransport, flushPromises, healthFetch, ManualTimers } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

function sessionRecord(sessionId: string, lastActivityAt: number): SessionRecord {
  // SAFETY: the list reads only these fields of a record.
  return { sessionId, provider: 'claude-code', projectPath: '/work/app', cwd: '/work/app', title: sessionId, lastActivityAt, size: 10 } as SessionRecord
}

const row = (sessionId: string, lastActivityAt: number, extra: Partial<SessionShellRow> = {}): SessionShellRow => ({
  record: sessionRecord(sessionId, lastActivityAt), pinnedAt: null, attention: null, automationName: null, agentActivity: null, ...extra,
})

const cursor = (sequence: number, epoch = 'epoch-1'): SessionShellCursor => ({ epoch, scopeKey: 'scope-key', sequence })

const snapshot = (sequence: number, rows: SessionShellRow[], epoch = 'epoch-1'): SessionShellSnapshot => ({
  cursor: cursor(sequence, epoch), rows, projects: [], codebases: null, indexing: false,
})

const saved = (scope: string, shell: SessionShellSnapshot) => JSON.stringify({ version: 1, scope, hostLabel: 'A', snapshot: shell })

const ids = (rows: readonly { record: { sessionId: string } }[]) => rows.map(item => item.record.sessionId)

/** Waits on promises and timers until `done` is true, for at most one second. */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; !done() && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 5))
}

/** A keychain whose reads wait until `open` is called: `load` stays pending while it waits. */
function slowSecrets(secrets: SecretStore = memorySecretStore()): SecretStore & { open(): void } {
  const gate = Promise.withResolvers<void>()
  return { ...secrets, get: async (key) => { await gate.promise; return secrets.get(key) }, open: () => gate.resolve() }
}

function phone(options: { api: FakeApi; store: SessionShellStore; storage?: ReturnType<typeof memoryKeyValueStore>; secrets?: SecretStore }) {
  const transports: FakeTransport[] = []
  const app = new SolusApp({
    storage: options.storage ?? memoryKeyValueStore(), secrets: options.secrets ?? memorySecretStore(),
    pullRequestCache: memoryPullRequestCacheDatabase(), sessionShellStore: options.store,
    fetch: healthFetch({ 'http://a:1': 'inst-a' }), uuid: () => crypto.randomUUID(),
    createTransport: transportOptions => {
      const transport = new FakeTransport(transportOptions, options.api)
      transports.push(transport)
      return transport
    },
    openBrowser: async () => {}, deviceLabel: 'Test phone',
  })
  return { app, transports }
}

/** A phone with host A paired and its saved shell read, as a start does before it connects. */
async function startedPhone(api: FakeApi, saved?: (scope: string) => string) {
  const store = memorySessionShellStore()
  const { app, transports } = phone({ api, store })
  await app.load()
  if (saved) await store.save('inst-a', app.sessionCache.scope(), saved(app.sessionCache.scope()))
  await app.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  await app.threads.restore('inst-a')
  return { app, store, transports }
}

/** What `runtime.ts` does for a host with the `sessionShell` capability. */
async function followShell(app: SolusApp, transports: FakeTransport[]) {
  app.connections.changes.subscribe(() => app.shells.sync('inst-a'))
  app.connections.connection('inst-a')
  app.shells.follow('inst-a', 'A')
  await transports[0]!.accept()
  await until(() => app.shells.statusOf('inst-a') === 'live')
}

describe('session shell reducer', () => {
  test('a row change replaces its row by key, keeps every other row, and orders by newest activity', () => {
    const held = snapshot(5, [row('s1', 3), row('s2', 2), row('s3', 1)])
    const next = applySessionShellChanges(held, {
      cursor: cursor(7),
      changes: [{ kind: 'row.updated', row: row('s3', 9) }, { kind: 'row.removed', sessionId: 's2' }],
    })
    expect(ids(next.rows)).toEqual(['s3', 's1'])
    expect(next.rows[1]).toBe(held.rows[0]!)
    expect(next.cursor.sequence).toBe(7)
  })

  test("an activity change sets the agent's activity of the row it names, and of no row the phone does not hold", () => {
    const held = snapshot(5, [row('s1', 3), row('s2', 2)])
    const next = applySessionShellChanges(held, {
      cursor: cursor(7),
      changes: [{ kind: 'row.activity', sessionId: 's1', agentActivity: 'edit' }, { kind: 'row.activity', sessionId: 'gone', agentActivity: 'run' }],
    })
    expect(next.rows.map(item => [item.record.sessionId, item.agentActivity])).toEqual([['s1', 'edit'], ['s2', null]])
    expect(next.rows[0]!.record).toBe(held.rows[0]!.record)
    expect(next.rows[1]).toBe(held.rows[1]!)
    // The same activity again changes nothing.
    expect(applySessionShellChanges(next, { cursor: cursor(7), changes: [{ kind: 'row.activity', sessionId: 's1', agentActivity: 'edit' }] })).toBe(next)
  })

  test('a change that repeats a row keeps the row and the snapshot', () => {
    const held = snapshot(5, [row('s1', 3)])
    expect(applySessionShellChanges(held, { cursor: cursor(5), changes: [{ kind: 'row.updated', row: row('s1', 3) }] })).toBe(held)
  })
})

describe('session shell driver', () => {
  test('a start paints from the saved record before any network read', async () => {
    const storage = memoryKeyValueStore()
    const secrets = memorySecretStore()
    const store = memorySessionShellStore()
    const scope = 'account-a'
    // The last start kept its scope and its host; the host's shell was saved in that scope.
    storage.setItem('solus.mobile.lastSessionList', JSON.stringify({ scope, hosts: [{ id: 'inst-a', installationId: 'inst-a' }] }))
    const waiting = { sessionId: 's1', kind: 'question' as const, since: 1, summary: 'Which branch?' }
    await store.save('inst-a', scope, saved(scope, snapshot(5, [row('s1', 2, { attention: waiting }), row('s2', 1)])))
    const api = new FakeApi()
    const slow = slowSecrets(secrets)
    const { app } = phone({ api, store, storage, secrets: slow })
    const loading = app.load()
    try {
      for (const host of app.presumeLastSessionList()) await app.threads.restore(host.id, host)
      expect(ids(app.threads.threads())).toEqual(['s1', 's2'])
      // The saved row's facts paint with it: a row that waits for the person must not change state when the host answers.
      expect([...(app.threadList.facts().attention?.values() ?? [])]).toEqual([waiting])
      expect(app.shells.statusOf('inst-a')).toBe('cached')
      expect(api.calls).toEqual([])
    } finally {
      slow.open()
      await loading
      app.dispose()
    }
  })

  test('a host with no change answers no changes, and the list keeps its arrays', async () => {
    const api = new FakeApi().on('sessionShellOpen', ({ after }: SessionShellOpenRequest): SessionShellOpenResult =>
      ({ kind: 'changes', fromSequence: after!.sequence, cursor: after!, changes: [] }))
    const { app, transports } = await startedPhone(api, scope => saved(scope, snapshot(5, [row('s1', 2), row('s2', 1)])))
    try {
      const shown = app.threads.threads()
      const value = app.threads.shownValue('inst-a')!
      const projects = app.threads.projects()
      expect(ids(shown)).toEqual(['s1', 's2'])
      await followShell(app, transports)
      expect(api.callsOf('sessionShellOpen')).toEqual([[{ after: cursor(5) }]])
      expect(app.threads.stateOf('inst-a').kind).toBe('loaded')
      expect(app.threads.threads()).toBe(shown)
      expect(app.threads.shownValue('inst-a')!.threads).toBe(value.threads)
      expect(app.threads.projects()).toBe(projects)
      // No directory read ran for this host.
      expect(api.callsOf('sessionDirectoryOpen')).toEqual([])
      expect(api.callsOf('sessionRecordList')).toEqual([])
    } finally { app.dispose() }
  })

  test('changes apply in order, and a gap opens the shell again with the held cursor', async () => {
    let opens = 0
    const api = new FakeApi().on('sessionShellOpen', ({ after }: SessionShellOpenRequest): SessionShellOpenResult => {
      opens++
      return opens === 1
        ? { kind: 'snapshot', snapshot: snapshot(5, [row('s1', 2)]) }
        : { kind: 'changes', fromSequence: after!.sequence, cursor: cursor(9), changes: [{ kind: 'row.updated', row: row('s9', 9) }] }
    })
    const { app, transports } = await startedPhone(api)
    try {
      await followShell(app, transports)
      expect(ids(app.threads.threads())).toEqual(['s1'])
      const next: SessionShellChanges = { fromSequence: 5, cursor: cursor(6), changes: [{ kind: 'row.updated', row: row('s6', 6) }] }
      transports[0]!.emit('sessionShell.changed', next)
      expect(ids(app.threads.threads())).toEqual(['s6', 's1'])
      // The changes after sequence 6 up to 8 never came.
      transports[0]!.emit('sessionShell.changed', { fromSequence: 8, cursor: cursor(9), changes: [{ kind: 'row.removed', sessionId: 's1' }] })
      await until(() => opens === 2 && app.shells.statusOf('inst-a') === 'live')
      expect(api.callsOf('sessionShellOpen')[1]).toEqual([{ after: cursor(6) }])
      expect(ids(app.threads.threads())).toEqual(['s9', 's6', 's1'])
    } finally { app.dispose() }
  })

  test('a new connection opens the shell again', async () => {
    const api = new FakeApi().on('sessionShellOpen', ({ after }: SessionShellOpenRequest): SessionShellOpenResult =>
      after ? { kind: 'changes', fromSequence: after.sequence, cursor: after, changes: [] } : { kind: 'snapshot', snapshot: snapshot(5, [row('s1', 2)]) })
    const { app, transports } = await startedPhone(api)
    try {
      await followShell(app, transports)
      transports[0]!.fail('dropped')
      await flushPromises()
      expect(app.shells.statusOf('inst-a')).toBe('cached')
      app.connections.retry('inst-a')
      await transports[0]!.whenDialed(2)
      await transports[0]!.accept()
      await until(() => api.callsOf('sessionShellOpen').length === 2 && app.shells.statusOf('inst-a') === 'live')
      expect(api.callsOf('sessionShellOpen')[1]).toEqual([{ after: cursor(5) }])
    } finally { app.dispose() }
  })

  test('only a host that names the sessionShell capability reads its list from the shell', async () => {
    const read = (capabilities: object) => readsSessionShell({
      value: () => undefined,
      when: async () => capabilities,
    } as unknown as Parameters<typeof readsSessionShell>[0])
    expect(await read({ sessionShell: true })).toBe(true)
    expect(await read({ sessionDirectoryOpen: true })).toBe(false)
    expect(readsSessionShell({ value: () => ({}), when: async () => ({}) } as unknown as Parameters<typeof readsSessionShell>[0])).toBe(false)
  })

  test('a host without the capability keeps the directory reads', async () => {
    const api = new FakeApi()
      .on('sessionRecordList', () => ({ records: [sessionRecord('old', 1)], nextCursor: null, indexing: false, revision: 'r1' }))
      .on('listProjects', () => [])
      .on('pinnedSessionsList', () => [])
      .on('sessionRecordGet', () => null)
    const { app, transports } = await startedPhone(api)
    try {
      app.connections.connection('inst-a')
      await transports[0]!.accept()
      expect(app.shells.follows('inst-a')).toBe(false)
      await app.threads.load('inst-a')
      expect(ids(app.threads.threads())).toEqual(['old'])
      expect(api.callsOf('sessionShellOpen')).toEqual([])
    } finally { app.dispose() }
  })

  test('a followed host answers its point reads and loads from the shell, not from the directory', async () => {
    const api = new FakeApi().on('sessionShellOpen', (): SessionShellOpenResult =>
      ({ kind: 'snapshot', snapshot: snapshot(5, [row('s1', 2), row('pinned-out', 1, { pinnedAt: 7, record: { ...sessionRecord('pinned-out', 1), listed: false } })]) }))
    const { app, transports } = await startedPhone(api)
    try {
      await followShell(app, transports)
      expect(app.threads.thread('inst-a', 's1')?.record.sessionId).toBe('s1')
      expect(app.threads.thread('inst-a', 'pinned-out')?.record.sessionId).toBe('pinned-out')
      expect(ids(app.threads.threads())).toEqual(['s1'])
      expect(app.threadList.facts().pins?.get('inst-a\u0000pinned-out')?.pinnedAt).toBe(7)
      await app.threads.load('inst-a')
      expect(api.callsOf('sessionShellOpen')).toHaveLength(1)
      expect(api.callsOf('sessionRecordList')).toEqual([])
    } finally { app.dispose() }
  })
})

describe('session shell record', () => {
  function connection(answer: (request: SessionShellOpenRequest) => Promise<SessionShellOpenResult> | SessionShellOpenResult) {
    const events = new HostEventSubscriber()
    const shellConnection: SessionShellConnection & { emit(changes: SessionShellChanges): void } = {
      api: { sessionShellOpen: async request => answer(request) },
      events,
      state: { readiness: 'ready', sessionGeneration: 1 },
      emit: changes => events.receive({ type: 'sessionShell.changed', payload: changes, occurredAt: Date.now() }),
    }
    return shellConnection
  }

  test('the record is saved at most once each 500 ms, only when the sequence moved forward', async () => {
    const store = memorySessionShellStore()
    const timers = new ManualTimers()
    const link = connection(() => ({ kind: 'snapshot', snapshot: snapshot(5, [row('s1', 1)]) }))
    const shells = new SessionShells({ store, scope: () => 'account', connectionFor: () => link, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })
    shells.follow('inst-a', 'A')
    await until(() => shells.statusOf('inst-a') === 'live')
    link.emit({ fromSequence: 5, cursor: cursor(6), changes: [{ kind: 'row.updated', row: row('s6', 6) }] })
    link.emit({ fromSequence: 6, cursor: cursor(7), changes: [{ kind: 'row.updated', row: row('s7', 7) }] })
    expect(timers.pending.size).toBe(1)
    timers.runAll()
    await flushPromises()
    const record = JSON.parse((await store.load('inst-a', 'account'))!)
    expect(record.snapshot.cursor.sequence).toBe(7)
    expect(ids(record.snapshot.rows)).toEqual(['s7', 's6', 's1'])
    // The same sequence again saves nothing.
    link.emit({ fromSequence: 7, cursor: cursor(7), changes: [] })
    expect(timers.pending.size).toBe(0)
  })

  test('an old scope never fills a new scope', async () => {
    const store = memorySessionShellStore()
    await store.save('inst-a', 'old', saved('old', snapshot(5, [row('theirs', 1)])))
    const read = Promise.withResolvers<void>()
    const slowStore = { ...store, load: async (hostId: string, scope: string) => { await read.promise; return store.load(hostId, scope) } }
    let scope = 'old'
    const timers = new ManualTimers()
    const link = connection(() => ({ kind: 'snapshot', snapshot: snapshot(1, [row('mine', 2)]) }))
    const shells = new SessionShells({ store: slowStore, scope: () => scope, connectionFor: () => link, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn })
    // The read of the old scope is in flight when the account changes.
    const restoring = shells.restore('inst-a', 'A')
    scope = 'new'
    shells.reset()
    read.resolve()
    expect(await restoring).toBeNull()
    expect(shells.snapshotOf('inst-a')).toBeNull()
    // The new scope reads its own record: there is none.
    expect(await shells.restore('inst-a', 'A')).toBeNull()
    shells.follow('inst-a', 'A')
    await until(() => shells.statusOf('inst-a') === 'live')
    timers.runAll()
    await flushPromises()
    expect(ids(JSON.parse((await store.load('inst-a', 'new'))!).snapshot.rows)).toEqual(['mine'])
    expect(ids(JSON.parse((await store.load('inst-a', 'old'))!).snapshot.rows)).toEqual(['theirs'])
  })

  test('a saved record of another scope is refused even under the current key', async () => {
    const store = memorySessionShellStore()
    await store.save('inst-a', 'new', saved('old', snapshot(5, [row('theirs', 1)])))
    const shells = new SessionShells({ store, scope: () => 'new', connectionFor: () => null })
    expect(await shells.restore('inst-a', 'A')).toBeNull()
    expect(shells.statusOf('inst-a')).toBe('empty')
  })
})
