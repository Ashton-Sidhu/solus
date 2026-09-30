import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentBackend, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { IpcContext, NormalizedEvent, QueuedPromptSnapshot } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SessionRuntimeModule = typeof import('@solus/server/execution/session-runtime')
type DbModule = typeof import('@solus/server/db')

// The control plane reads session lineage from the host database: point it at a
// disposable directory so the test never opens live Solus data.
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let sessionRuntimeModule: SessionRuntimeModule
let db: DbModule
let actors: typeof import('./helpers/actors')
let HOST_ACTOR: typeof import('@solus/server/admission/actor')['HOST_ACTOR']

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-queue-author-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  db = await import('@solus/server/db')
  actors = await import('./helpers/actors')
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

// docs/plans/multiplayer-presence.md §5: a held prompt names its author on the
// queue event and on the snapshot a reconnecting client reads, the same way a
// sent prompt names it on the transcript echo. The host's own work carries no name.

/** A backend whose runs stay busy until the test lets them go, so a second prompt queues. */
function holdingBackend() {
  const handles = new Map<string, RunHandle>()
  const releases: Array<() => void> = []
  const requests: AgentRunRequest[] = []
  const backend = Object.assign(new EventEmitter(), {
    id: 'claude-code' as const,
    metadata: { id: 'claude-code' as const, label: 'Claude', models: [], defaultModel: '' },
    permissions: { getPendingInfo: () => undefined, respondToPermission: () => false, respondToQuestion: () => false, clearPendingForSession: () => {}, setCurrentSessionId: () => {} },
    getEnrichedError: () => ({ message: '', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 }),
    isSessionRunning: (threadId: string) => handles.has(threadId),
    getSessionHandle: (threadId: string) => handles.get(threadId),
    // A cancelled run exits the way a provider does after an interrupt.
    cancelSession: (threadId: string) => {
      if (!handles.has(threadId)) return false
      queueMicrotask(() => { handles.delete(threadId); backend.emit('exit', threadId, null, 'SIGINT') })
      return true
    },
    getPendingHandles: () => [],
    shutdown: () => {},
    startRun(request: AgentRunRequest): RunHandle {
      requests.push(request)
      let resolve!: () => void
      const runPromise = new Promise<void>((res) => { resolve = res })
      const threadId = `thread-${handles.size + 1}`
      const handle: RunHandle = {
        agentSessionId: threadId,
        persistence: request.persistence,
        startedAt: Date.now(),
        toolCallCount: 0,
        sawPermissionRequest: false,
        permissionDenials: [],
        abortController: new AbortController(),
        runPromise,
        _resolveRun: resolve,
        _rejectRun: () => {},
      }
      handles.set(threadId, handle)
      releases.push(() => { handles.delete(threadId); resolve(); backend.emit('exit', threadId, 0, null) })
      // The provider names its thread, which binds the session to it so a later
      // prompt for the same session finds it busy.
      queueMicrotask(() => {
        backend.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'test', skills: [] } satisfies NormalizedEvent)
      })
      return handle
    },
  })
  return { value: backend as unknown as AgentBackend, requests, releaseAll: () => { for (const release of releases.splice(0)) release() } }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  db.closeDb()
})

function ctx(sessionId: string, agentSessionId: string | null = null): IpcContext {
  return {
    session: { sessionId, provider: 'claude-code', agentSessionId, workingDirectory: '/tmp/project', origin: 'user' },
    window: {},
    settings: { activeAgent: 'claude-code' },
    statusBar: { model: null, reasoningEffort: 'medium', permissionMode: 'full-access' },
  } as unknown as IpcContext
}

describe('queue author', () => {
  test('a member\'s held prompt is stamped with their identity; the host\'s own is not', async () => {
    const backend = holdingBackend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

    await plane.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    await Promise.resolve()
    const second = await plane.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'then deploy', clientPromptId: 'p-cara', delivery: 'queue' }, {
      clientId: 'c-cara', actor: actors.memberActor('cara', 'Cara', { avatarUrl: 'https://x/cara.png' }),
    })
    expect(second.disposition).toBe('queued')
    await plane.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'and the host', delivery: 'queue' }, { clientId: 'c-owner', actor: HOST_ACTOR })

    const cara = actors.accountUser('cara', 'Cara', { avatarUrl: 'https://x/cara.png' })
    const queued = events.filter((event): event is Extract<NormalizedEvent, { type: 'prompt_queued' }> => event.type === 'prompt_queued')
    expect(queued.map((event) => event.author)).toEqual([cara, undefined])

    // A client that connects later reads the same names from the queue snapshot
    // (the one `watchSession` attaches; read directly, since attaching also
    // reconciles the run, which is not what is under test).
    const snapshot = (plane as unknown as { _queuedPromptsForSession(sessionId: string): QueuedPromptSnapshot[] })._queuedPromptsForSession('s1')
    expect(snapshot.map((prompt) => [prompt.clientPromptId, prompt.author])).toEqual([['p-cara', cara], [undefined, undefined]])
  })
})

// plans/004-shared-host-collaboration.md D12: Stop ends the running turn and
// keeps every queued prompt, other people's included.
describe('stop keeps the queue', () => {
  test('Cara stopping Bob\'s turn names her and starts her queued prompt, on her seat', async () => {
    const backend = holdingBackend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    plane.useSeats({
      resolveForTurn: async (seat: { kind: string; userId?: { accountId: string } }) => ({ seat, provider: 'claude', home: `/seats/${seat.userId?.accountId ?? 'host'}` }),
    } as unknown as Parameters<typeof plane.useSeats>[0])
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

    await plane.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    await Promise.resolve()
    const queued = await plane.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'then deploy', delivery: 'queue' }, {
      clientId: 'c-cara', actor: actors.memberActor('cara', 'Cara'),
    })
    expect(queued.disposition).toBe('queued')

    // Cara stops Bob's turn (D2): the stop is her activity, inside the turn it
    // ended (plans/012 §5), so no reader is told they did it.
    const caraAuthor = actors.accountUser('cara', 'Cara')
    expect(plane.stopSession('s1', actors.memberActor('cara', 'Cara'))).toBe(true)
    const stoppedActivity = () => events.find((event): event is Extract<NormalizedEvent, { type: 'activity' }> => event.type === 'activity' && event.activity.kind === 'stopped')
    for (let i = 0; i < 20 && (backend.requests.length < 2 || !stoppedActivity()); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stoppedActivity()?.activity).toMatchObject({ kind: 'stopped', by: { kind: 'user', user: caraAuthor }, subject: { kind: 'session', id: 's1' } })
    expect(stoppedActivity()?.activity.turnId).toBeString()
    const interrupted = events.find((event) => event.type === 'status_change' && event.status === 'interrupted')
    expect(interrupted).not.toHaveProperty('by')

    expect(backend.requests.map((request) => request.prompt)).toEqual(['start', 'then deploy'])
    expect(backend.requests[1]?.seat?.seat).toEqual({ kind: 'user', userId: { kind: 'account', accountId: 'cara' } })
    const dequeued = events.filter((event) => event.type === 'prompt_dequeued')
    expect(dequeued).toHaveLength(1)
  })
})

// plans/004-shared-host-collaboration.md F2, F4: a card says whose turn asks, and
// every client reads who decided a permission and how. A teammate learns who
// waits on a seat; the refused client has its own card.
describe('whose turn asks, and what was chosen', () => {
  test('a request raised in Bob\'s turn names Bob, and Cara\'s approval names her and the decision', async () => {
    const backend = holdingBackend()
    let answered: string | null = null
    backend.value.permissions.respondToPermission = (_questionId: string, optionId: string) => { answered = optionId; return true }
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

    await plane.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    await Promise.resolve()
    const bob = actors.accountUser('bob', 'Bob')
    const options = [{ id: 'allow', label: 'Allow Once', kind: 'allow' }, { id: 'allow-session', label: 'Allow for Session', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }]
    backend.value.emit('normalized', 'thread-1', { type: 'permission_request', questionId: 'q1', toolName: 'Bash', options } satisfies NormalizedEvent)
    backend.value.emit('normalized', 'thread-1', { type: 'question_request', questionId: 'q2', questions: [] } satisfies NormalizedEvent)

    const asked = events.filter((event) => event.type === 'permission_request' || event.type === 'question_request')
    expect(asked.map((event) => 'turnAuthor' in event ? event.turnAuthor : undefined)).toEqual([bob, bob])

    const cara = actors.accountUser('cara', 'Cara')
    expect(plane.respondToPermission('s1', 'q1', 'allow-session', undefined, actors.memberActor('cara', 'Cara'))).toBe(true)
    expect(answered).toBe('allow-session')
    const resolved = events.find((event) => event.type === 'permission_resolved')
    expect(resolved).toEqual({ type: 'permission_resolved', questionId: 'q1', decision: 'approved_for_session' })
    // Who decided is one activity every client reads (plans/012 §5).
    const decided = () => events.find((event): event is Extract<NormalizedEvent, { type: 'activity' }> => event.type === 'activity')
    for (let i = 0; i < 20 && !decided(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(decided()?.activity).toMatchObject({ kind: 'permission_decided', questionId: 'q1', tool: 'Bash', decision: 'approved_for_session', by: { kind: 'user', user: cara } })
  })

  test('the decision is read from the option\'s kind; an option the request did not offer names none', () => {
    const request = {
      type: 'permission_request' as const, questionId: 'q', toolName: 'Bash',
      options: [{ id: 'accept', label: 'Allow', kind: 'allow' }, { id: 'acceptForSession', label: 'Allow for session', kind: 'allow' }, { id: 'decline', label: 'Deny', kind: 'deny' }],
    }
    expect(sessionRuntimeModule.permissionDecisionFor(request, 'accept')).toBe('approved')
    expect(sessionRuntimeModule.permissionDecisionFor(request, 'acceptForSession')).toBe('approved_for_session')
    expect(sessionRuntimeModule.permissionDecisionFor(request, 'decline')).toBe('denied')
    expect(sessionRuntimeModule.permissionDecisionFor(request, 'nope')).toBeUndefined()
  })

  test('a refused seat tells the room who waits on it, as an activity', async () => {
    const { SeatRequiredError } = await import('@solus/server/execution/seats/seat-manager')
    const backend = holdingBackend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    plane.useSeats({
      resolveForTurn: async (seat: { userId?: { accountId: string } }) => { throw new SeatRequiredError(seat.userId?.accountId === 'dan' ? 'claude-code' : 'codex', 'none') },
    } as unknown as Parameters<typeof plane.useSeats>[0])
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const sent: Array<{ event: NormalizedEvent; to?: { only?: string; except?: string } }> = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => { sent.push({ event, to }) })

    await expect(plane.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-dan', actor: actors.memberActor('dan', 'Dan') })).rejects.toBeInstanceOf(SeatRequiredError)
    const notice = () => sent.find(({ event }) => event.type === 'activity')
    for (let i = 0; i < 20 && !notice(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notice()?.event).toMatchObject({ type: 'activity', activity: { kind: 'seat_needed', provider: 'claude-code', by: { kind: 'user', user: actors.accountUser('dan', 'Dan') } } })
    // Everyone reads it; the refused client's own row names them "you" and is not drawn (showsActivity).
    expect(notice()?.to).toBeUndefined()
  })
})
