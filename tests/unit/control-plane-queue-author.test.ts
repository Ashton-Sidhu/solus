import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentBackend, RunHandle } from '@solus/server/agents/agent-backend'
import type { IpcContext, NormalizedEvent, QueuedPromptSnapshot } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ControlPlaneModule = typeof import('@solus/server/control-plane')
type DbModule = typeof import('@solus/server/db')

// The control plane reads session lineage from the host database: point it at a
// disposable directory so the test never opens live Solus data.
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let controlPlaneModule: ControlPlaneModule
let db: DbModule
let presenceColorIndex: typeof import('@solus/server/presence/presence-color')['presenceColorIndex']

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-queue-author-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  db = await import('@solus/server/db')
  ;({ presenceColorIndex } = await import('@solus/server/presence/presence-color'))
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
  const backend = Object.assign(new EventEmitter(), {
    id: 'claude-code' as const,
    metadata: { id: 'claude-code' as const, label: 'Claude', models: [], defaultModel: '' },
    permissions: { getPendingInfo: () => undefined, respondToPermission: () => false, respondToQuestion: () => false, clearPendingForSession: () => {}, setCurrentSessionId: () => {} },
    getEnrichedError: () => ({ message: '', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 }),
    isSessionRunning: (threadId: string) => handles.has(threadId),
    getSessionHandle: (threadId: string) => handles.get(threadId),
    cancelSession: () => false,
    getPendingHandles: () => [],
    shutdown: () => {},
    startRun(request: AgentRunRequest): RunHandle {
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
  return { value: backend as unknown as AgentBackend, releaseAll: () => { for (const release of releases.splice(0)) release() } }
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
    statusBar: { model: null, reasoningEffort: 'medium', permissionMode: 'auto' },
  } as unknown as IpcContext
}

describe('queue author', () => {
  test('a member\'s held prompt is stamped with their identity; the host\'s own is not', async () => {
    const backend = holdingBackend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

    await plane.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-bob', actor: { userId: 'bob', seatUserId: 'bob', displayName: 'Bob' } })
    await Promise.resolve()
    const second = await plane.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'then deploy', clientPromptId: 'p-cara', delivery: 'queue' }, {
      clientId: 'c-cara', actor: { userId: 'cara', seatUserId: 'cara', displayName: 'Cara', avatarUrl: 'https://x/cara.png' },
    })
    expect(second.disposition).toBe('queued')
    await plane.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'and the host', delivery: 'queue' }, { clientId: 'c-owner', actor: { userId: 'host-owner', seatUserId: 'host-owner' } })

    const cara = { userId: 'cara', displayName: 'Cara', avatarUrl: 'https://x/cara.png', colorIndex: presenceColorIndex('cara') }
    const queued = events.filter((event): event is Extract<NormalizedEvent, { type: 'prompt_queued' }> => event.type === 'prompt_queued')
    expect(queued.map((event) => event.author)).toEqual([cara, undefined])

    // A client that connects later reads the same names from the queue snapshot
    // (the one `watchSession` attaches; read directly, since attaching also
    // reconciles the run, which is not what is under test).
    const snapshot = (plane as unknown as { _queuedPromptsForSession(sessionId: string): QueuedPromptSnapshot[] })._queuedPromptsForSession('s1')
    expect(snapshot.map((prompt) => [prompt.clientPromptId, prompt.author])).toEqual([['p-cara', cara], [undefined, undefined]])
  })
})
