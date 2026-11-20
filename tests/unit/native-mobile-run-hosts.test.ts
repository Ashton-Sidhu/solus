import { describe, expect, test } from 'bun:test'
import type { SessionSyncFailure } from '@solus/contracts/rpc'
import type { SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { sessionSyncCardView, sessionSyncFailureText } from '@solus/client-core/session-sync-card'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import type { ConversationStore } from '../../apps/mobile/src/features/conversation/conversation-store'
import { SessionRunHosts } from '../../apps/mobile/src/features/threads/session-run-hosts'
import { ThreadDirectory } from '../../apps/mobile/src/features/threads/thread-directory'
import { runHostRowNote, runHostRowView, type RunHostRowInput } from '../../apps/mobile/src/features/threads/lib/run-host-row'
import { threadHostChrome, withRunHostChoice } from '../../apps/mobile/src/features/threads/lib/thread-host-chrome'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { FakeApi, FakeTransport, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

const SESSION = 'session-1'
const record = { sessionId: SESSION, provider: 'claude-code' as const, projectPath: '/a/app', cwd: '/a/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null }
const meta = (head: string | null, syncedTurn: number, cwd = '/a/app') => ({ sessionId: SESSION, provider: 'claude-code', head, syncedTurn, cwd, projectPath: cwd })

/** A host's API for one saved session: its history, its watch, and its session repository facts. */
function hostApi(facts: { head: string | null; syncedTurn: number; cwd: string } | null): FakeApi {
  return new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: facts ? meta(facts.head, facts.syncedTurn, facts.cwd) : null }))
    .on('loadSessionPage', () => ({ messages: [{ role: 'user', content: 'hello', messageId: 'm1', timestamp: 1 }], before: null }))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('prompt', () => ({ disposition: 'started' }))
    .on('getSessionInfos', (ids: string[]) => ids.map(() => (facts ? meta(facts.head, facts.syncedTurn, facts.cwd) : null)))
    .on('sessionPrepare', () => ({ state: 'started' }))
}

function untilReady(store: ConversationStore): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (store.controller.phase.kind !== 'ready') return
      stop()
      resolve()
    }
    const stop = store.meta.subscribe(check)
    check()
  })
}

/** The phone with two connected hosts, A and B. */
async function twoHosts(apis: { a: FakeApi; b: FakeApi }) {
  const transports = new Map<string, FakeTransport>()
  let nextId = 0
  const app = new SolusApp({
    storage: memoryKeyValueStore(),
    secrets: memorySecretStore(),
    fetch: healthFetch({ 'http://a:1': 'inst-a', 'http://b:1': 'inst-b' }),
    createTransport: (options) => {
      const transport = new FakeTransport(options, options.serverId === 'inst-a' ? apis.a : apis.b)
      transports.set(options.serverId ?? "", transport)
      return transport
    },
    openBrowser: async () => {},
    deviceLabel: 'Solus for iPhone',
    uuid: () => `uuid-${++nextId}`,
  })
  await app.load()
  await app.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'Studio', url: 'http://a:1' }, 'ta')
  await app.registry.savePaired({ id: 'inst-b', identityKey: identityKeyFor('inst-b'), label: 'Laptop', url: 'http://b:1' }, 'tb')
  for (const hostId of ['inst-a', 'inst-b']) {
    app.connections.connection(hostId)
    await transports.get(hostId)!.accept()
  }
  await flushPromises()
  return { app, transports }
}

const idle: RunHostRowInput = {
  runHostId: 'a',
  isStarted: true,
  mayDrive: true,
  status: 'idle',
  backgroundWorkRunning: false,
  hasUnsentPrompts: false,
  hasAttachments: false,
  newestHostId: 'a',
  hosts: [
    { hostId: 'a', label: 'Studio', isReady: true, isAway: false },
    { hostId: 'b', label: 'Laptop', isReady: true, isAway: false },
  ],
}

describe('mobile host control for a started session', () => {
  test('is open between turns and locked while a turn runs or a prompt waits', () => {
    // WHY: no host owns a session, but one turn runs at a time (plan §4 decision 5):
    // the host changes only between turns, never under a running turn or an unsent prompt.
    expect(runHostRowView(idle)).toMatchObject({ isShown: true, isLocked: false, runHostLabel: 'Studio' })
    expect(runHostRowView({ ...idle, status: 'running' }).isLocked).toBe(true)
    expect(runHostRowView({ ...idle, status: 'awaiting_input' }).isLocked).toBe(true)
    expect(runHostRowView({ ...idle, hasUnsentPrompts: true }).isLocked).toBe(true)
    // Uploaded files are on the run host; a pick would leave them behind.
    expect(runHostRowView({ ...idle, hasAttachments: true }).isLocked).toBe(true)
  })

  test('shows only when another host is connected, for a reader who may prompt', () => {
    // WHY: docs/run-on.md: the host control hides when there is no other host choice.
    const alone = { ...idle, hosts: [idle.hosts[0]!, { ...idle.hosts[1]!, isReady: false, isAway: true }] }
    expect(runHostRowView(alone).isShown).toBe(false)
    expect(runHostRowView({ ...idle, mayDrive: false }).isShown).toBe(false)
    expect(runHostRowView({ ...idle, isStarted: false }).isShown).toBe(false)
  })

  test('says the host with the newest turn is offline, and keeps the composer when the run host is that host', () => {
    // WHY: plan §10: "<host> is offline" with the host control; typing stays possible.
    const away = { ...idle, hosts: [{ ...idle.hosts[0]!, isReady: false, isAway: true }, idle.hosts[1]!] }
    const view = runHostRowView(away)
    expect(runHostRowNote(view)).toBe('Studio is offline')
    expect(view.keepsComposerWhileAway).toBe(true)
    // The composer takes the asleep card's place; cards that need the host stay hidden.
    const chrome = withRunHostChoice(threadHostChrome({ readiness: 'unreachable', away: true }), view.keepsComposerWhileAway)
    expect(chrome).toMatchObject({ showsComposer: true, isAsleep: false, showsRequestCards: false })
    // Not known which host has the newest turn: nothing is said, and the host footer stays.
    expect(runHostRowView({ ...away, newestHostId: null })).toMatchObject({ offlineHostLabel: null, keepsComposerWhileAway: false })
    // Another host has the newest turn and it is away: the run host stays usable.
    const otherAway = { ...idle, newestHostId: 'b', hosts: [idle.hosts[0]!, { ...idle.hosts[1]!, isReady: false, isAway: true }, { hostId: 'c', label: 'Box', isReady: true, isAway: false }] }
    expect(runHostRowNote(runHostRowView(otherAway))).toBe('Laptop is offline')
    expect(runHostRowView(otherAway).keepsComposerWhileAway).toBe(false)
  })
})

describe('mobile run host change', () => {
  test('a pick opens the conversation on the new host at once and prepares it from the newest host', async () => {
    // WHY: plan §10: a pick changes where the next prompt goes at once (no wait); the
    // new host syncs in the background from the host with the newest turn, named by
    // its installation id, with the newest head this device knows.
    const a = hostApi({ head: 'h2', syncedTurn: 2, cwd: '/a/app' })
    const b = hostApi(null)
    const { app } = await twoHosts({ a, b })
    const onA = app.conversation('inst-a', { record })!
    await untilReady(onA)
    const transcript = onA.controller.model

    const onB = app.moveConversation(onA, 'inst-b')!
    expect(onB.controller.hostId).toBe('inst-b')
    // The conversation stays on screen: the same transcript, and the old host's copy closed.
    expect(onB.controller.model).toBe(transcript)
    expect(app.openConversation('inst-a', SESSION)).toBeNull()

    await untilReady(onB)
    await flushPromises()
    expect(b.callsOf('sessionPrepare')).toEqual([[{ sessionId: SESSION, knownHead: 'h2', sourceHostId: 'inst-a' }]])
    // B has no copy yet: its history is not read until it is current.
    expect(b.callsOf('loadSessionPage')).toEqual([])
  })

  test('a prompt to a host that is behind carries the newest head and its host; one to the newest host carries neither', async () => {
    // WHY: plan §7.1: the prompt carries `knownHead` from data the client has, so a turn
    // start makes no new request; a head sent to the newest host would sync for nothing.
    const a = hostApi({ head: 'h2', syncedTurn: 2, cwd: '/a/app' })
    const b = hostApi(null)
    const { app } = await twoHosts({ a, b })
    const onA = app.conversation('inst-a', { record })!
    await untilReady(onA)
    await onA.controller.send('on the newest host')
    const [, onAOptions] = a.callsOf('prompt')[0]! as [unknown, Record<string, unknown>]
    expect(onAOptions.knownHead).toBeUndefined()
    expect(onAOptions.sourceHostId).toBeUndefined()

    const onB = app.moveConversation(onA, 'inst-b')!
    await untilReady(onB)
    const before = a.calls.length
    await onB.controller.send('continue there')
    const [, onBOptions] = b.callsOf('prompt')[0]! as [unknown, Record<string, unknown>]
    expect(onBOptions).toMatchObject({ knownHead: 'h2', sourceHostId: 'inst-a', prompt: 'continue there' })
    // The send asked nothing of the host with the newest turn.
    expect(a.calls.slice(before).map((call) => call.method)).not.toContain('getSessionInfos')
  })

  test('the new host reads its own history in its own folder once its sync ends', async () => {
    // WHY: plan §19 Phase 4A decision 4: after a sync, the run host keeps the session in
    // the worktree it restored, and a later prompt uses that working directory.
    const a = hostApi({ head: 'h2', syncedTurn: 2, cwd: '/a/app' })
    const b = hostApi(null)
    const { app, transports } = await twoHosts({ a, b })
    const onA = app.conversation('inst-a', { record })!
    await untilReady(onA)
    const onB = app.moveConversation(onA, 'inst-b')!
    await untilReady(onB)
    b.on('describeSession', () => ({ lineage: null, meta: meta('h2', 2, '/b/projects/app') }))
    transports.get('inst-b')!.emitSession(SESSION, { type: 'status_card', card: { id: `session-sync-${SESSION}`, title: 'Session ready', status: 'done', steps: [] } })
    await untilReady(onB)
    await flushPromises()
    expect(b.callsOf('loadSessionPage')).toHaveLength(1)
    expect(onB.controller.run.workingDirectory).toBe('/b/projects/app')
  })

  test('opening a session prepares its host only when another host is ahead', async () => {
    // WHY: plan §10: opening a session whose host is not current calls sessionPrepare,
    // so the host is usually ready before the person sends; a current host is not asked.
    const prepared: unknown[] = []
    const connection = (facts: { head: string; syncedTurn: number }) => ({
      api: {
        getSessionInfos: async (ids: string[]) => ids.map(() => meta(facts.head, facts.syncedTurn)),
        sessionPrepare: async (request: unknown) => { prepared.push(request); return { state: 'started' } },
      },
      facts: { value: () => undefined },
    })
    const hosts = { a: connection({ head: 'h3', syncedTurn: 3 }), b: connection({ head: 'h1', syncedTurn: 1 }) }
    // SAFETY: the run host owner reads only these members of a connection.
    const runHosts = new SessionRunHosts({ readyConnection: (hostId) => hosts[hostId as 'a' | 'b'] as never })
    expect(await runHosts.opened(SESSION, 'b', null)).toBeNull()
    expect(prepared).toEqual([])

    runHosts.noteMeta('a', meta('h3', 3))
    runHosts.noteMeta('b', meta('h1', 1))
    expect(await runHosts.opened(SESSION, 'a', null)).toBeNull()
    await runHosts.opened(SESSION, 'b', null)
    expect(prepared).toEqual([{ sessionId: SESSION, knownHead: 'h3', sourceHostId: 'a' }])
  })

  test('a turn that ends on a host makes it the newest, so a prompt there carries no head', () => {
    // WHY: a host writes its turn commit after the turn; the device must not send
    // that host back to sync from a host that is now behind.
    const runHosts = new SessionRunHosts({ readyConnection: () => null })
    runHosts.noteMeta('a', meta('h2', 2))
    runHosts.noteMeta('b', meta('h1', 1))
    expect(runHosts.promptFields(SESSION, 'b')).toEqual({ knownHead: 'h2', sourceHostId: 'a' })
    runHosts.noteTurnSettled('b', SESSION)
    expect(runHosts.newestHostOf(SESSION)).toBe('b')
    expect(runHosts.promptFields(SESSION, 'b')).toEqual({})
  })
})

describe('mobile session list with portable sessions', () => {
  test('a session on two hosts shows once, from the host with more turns', async () => {
    // WHY: plan §9: one session, one row; the row comes from the host with the newest turn.
    const listed = (sessionId: string, lastActivityAt: number) => ({ sessionId, provider: 'claude-code', projectPath: '/p', cwd: '/p', title: sessionId, lastActivityAt }) as unknown as SessionRecord
    const connection = (records: SessionRecord[], syncedTurn: number) => ({
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async (filter: SessionRecordListFilter) => ({ records: filter.scope === 'all' ? [] : records, indexing: false }),
        listProjects: async () => [],
      pinnedSessionsList: async () => [],
        getSessionInfos: async (ids: string[]) => ids.map((sessionId) => ({ sessionId, head: `head-${syncedTurn}`, syncedTurn })),
      },
      facts: { value: () => undefined },
    })
    const connections = {
      a: connection([listed(SESSION, 10), listed('only-a', 5)], 2),
      b: connection([listed(SESSION, 9)], 3),
    }
    const hosts = [{ id: 'a', label: 'Studio' }, { id: 'b', label: 'Laptop' }]
    // SAFETY: the directory and the run host owner read only these members.
    const runHosts = new SessionRunHosts({ readyConnection: (hostId) => connections[hostId as 'a' | 'b'] as never })
    const directory = new ThreadDirectory(
      { host: (id: string) => hosts.find((host) => host.id === id), hosts: () => hosts } as never,
      (hostId) => connections[hostId as 'a' | 'b'] as never,
      runHosts,
    )
    await directory.load('a')
    await directory.load('b')
    await flushPromises()
    const rows = directory.threads().map((thread) => `${thread.hostId}:${thread.record.sessionId}`)
    expect(rows).toEqual([`b:${SESSION}`, 'a:only-a'])
    // Each host's own copy stays readable: a thread screen on either host opens it.
    expect(directory.thread('a', SESSION)?.record.sessionId).toBe(SESSION)
  })
})

describe('mobile sync card', () => {
  const reasons = [
    'provider-unavailable', 'seat-required', 'model-unavailable', 'provider-too-old',
    'source-offline', 'no-repository', 'not-signed-in', 'commit-failed', 'no-project-checkout', 'diverged',
    'code-restore', 'thread-conflict', 'interrupted', 'failed',
  ] as const satisfies readonly SessionSyncFailure[]
  // A new reason that this list misses fails to compile here.
  const everyReason: Exclude<SessionSyncFailure, (typeof reasons)[number]> extends never ? true : false = true
  const names = { sourceHost: 'Studio', runHost: 'Laptop', provider: 'Claude' }

  test('each sync failure has a plain text with the names of the hosts', () => {
    // WHY: a failed sync must say why and what to do; mobile has no copied files, so
    // `no-project-checkout` is the text a person on the phone sees for a host with no checkout.
    expect(everyReason).toBe(true)
    for (const reason of reasons) {
      const { message } = sessionSyncFailureText(reason, names)
      expect(message.length).toBeGreaterThan(10)
      expect(message).not.toContain('undefined')
    }
    expect(sessionSyncFailureText('no-project-checkout', names).message).toContain('Laptop has no copy of this project')
    expect(sessionSyncFailureText('source-offline', names).message).toContain('Studio is offline')
  })

  test('the card shows the step labels and the hosts by name', () => {
    // WHY: the host speaks in ids; the phone shows the same words as desktop and web.
    const card = sessionSyncCardView({
      id: `session-sync-${SESSION}`, title: 'x', status: 'active',
      steps: [{ id: 'fetch', label: 'fetch', status: 'active' }, { id: 'thread', label: 'thread', status: 'pending' }],
    }, names)
    expect(card.title).toBe('Syncing from Studio')
    expect(card.steps.map((step) => step.label)).toEqual(['Getting the session from Studio', 'Restoring the conversation'])
  })
})
