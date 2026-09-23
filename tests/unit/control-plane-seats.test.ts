import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentBackend, RunHandle } from '@solus/server/agents/agent-backend'
import type { IpcContext } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ControlPlane: typeof import('@solus/server/control-plane')['ControlPlane']
let SeatManager: typeof import('@solus/server/seats/seat-manager')['SeatManager']
let TurnLedger: typeof import('@solus/server/sessions/turn-ledger')['TurnLedger']

beforeAll(async () => {
  ;({ ControlPlane } = await import('@solus/server/control-plane'))
  ;({ SeatManager } = await import('@solus/server/seats/seat-manager'))
  ;({ TurnLedger } = await import('@solus/server/sessions/turn-ledger'))
})

// Step 2 plan §3.3 and exit criterion 2: a member with no seat is refused with
// SEAT_REQUIRED and no process is spawned; with one, the run request carries it
// and the ledger names both the author and the seat.

function backend() {
  const emitter = new EventEmitter() as EventEmitter & Pick<AgentBackend, 'id' | 'metadata' | 'permissions' | 'startRun' | 'getPendingHandles' | 'shutdown' | 'getEnrichedError' | 'cancelSession'>
  const started: AgentRunRequest[] = []
  emitter.id = 'claude-code'
  emitter.metadata = { id: 'claude-code', label: 'Claude', models: [], defaultModel: '' }
  emitter.permissions = { getPendingInfo: () => undefined, respondToPermission: () => false, respondToQuestion: () => false, clearPendingForSession: () => {}, setCurrentSessionId: () => {} }
  emitter.getEnrichedError = () => ({ message: '', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
  emitter.startRun = (request: AgentRunRequest) => {
    started.push(request)
    let resolve!: () => void
    const runPromise = new Promise<void>((res) => { resolve = res })
    // The thread id is known at once, as on a resume, so the lifecycle needs no session_init.
    const threadId = `thread-${started.length}`
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
    setImmediate(() => {
      resolve()
      emitter.emit('exit', threadId, 0, null)
    })
    return handle
  }
  emitter.getPendingHandles = () => []
  emitter.shutdown = () => {}
  emitter.cancelSession = () => false
  return { value: emitter, started }
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function harness() {
  const fake = backend()
  const plane = new ControlPlane(new Map([['claude-code', fake.value as never]]))
  const root = mkdtempSync(join(tmpdir(), 'plane-seats-'))
  const db = new Database(':memory:') as unknown as DatabaseSync
  const seats = new SeatManager({ db, seatsRoot: join(root, 'seats'), hostClaudeDir: join(root, '.claude'), hostCodexHome: join(root, '.codex') })
  const ledger = new TurnLedger(db)
  plane.useSeats(seats, ledger)
  cleanups.push(() => { plane.shutdown(); rmSync(root, { recursive: true, force: true }) })
  return { plane, seats, ledger, started: fake.started }
}

function ctx(sessionId: string): IpcContext {
  return {
    session: { sessionId, provider: 'claude-code', agentSessionId: null, workingDirectory: '/tmp/project', origin: 'user' },
    window: {},
    settings: { activeAgent: 'claude-code' },
    statusBar: { model: null, reasoningEffort: 'medium', permissionMode: 'auto' },
  } as unknown as IpcContext
}

describe('seats at dispatch', () => {
  test('a member with no seat is refused with SEAT_REQUIRED and nothing is spawned', async () => {
    const { plane, started } = harness()
    let refusal: unknown
    try {
      await plane.submitPrompt(ctx('s1'), { prompt: 'hello' }, { clientId: 'c1', actor: { userId: 'bob', seatUserId: 'bob' } })
    } catch (error) { refusal = error }
    expect((refusal as { code?: string }).code).toBe('SEAT_REQUIRED')
    expect(started).toHaveLength(0)
  })

  test('the host owner runs on the host login; a connected member\'s seat rides the run request and the ledger names both people', async () => {
    const { plane, seats, ledger, started } = harness()
    await plane.submitPrompt(ctx('s-owner'), { prompt: 'hello' }, { clientId: 'c1', actor: { userId: 'host-owner', seatUserId: 'host-owner' } })
    expect(started[0]?.seat).toMatchObject({ userId: 'host-owner', isHostLogin: true })
    expect(started[0]?.seat?.envToken).toBeUndefined()

    seats.storeToken('bob', 'claude-code', 'bob-token')
    await plane.submitPrompt(ctx('s-guest'), { prompt: 'hi from a guest', clientPromptId: 'p-guest' }, { clientId: 'c2', actor: { userId: 'guest:g1', seatUserId: 'bob' } })
    expect(started[1]?.seat).toMatchObject({ userId: 'bob', provider: 'claude-code', envToken: 'bob-token' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [turn] = ledger.forSession('s-guest')
    expect(turn).toMatchObject({ prompt_id: 'p-guest', user_id: 'guest:g1', seat_user_id: 'bob', provider: 'claude-code' })
    expect(turn?.state).not.toBe('running')
  })

  test('a prompt id seen in another session is not a duplicate, even once the ledger holds it', async () => {
    // WHY: a client prompt id is unique only to the client that made it; older
    // clients counted `msg-1`, `msg-2`… from zero on each reload. Matching the id
    // alone against past turns dropped a new session's first prompt as a replay.
    const { plane, ledger, started } = harness()
    const owner = { clientId: 'c1', actor: { userId: 'host-owner', seatUserId: 'host-owner' } }
    expect(await plane.submitPrompt(ctx('s-first'), { prompt: 'first', clientPromptId: 'msg-1' }, owner)).toMatchObject({ disposition: 'started' })
    expect(ledger.forSession('s-first')[0]?.prompt_id).toBe('msg-1')

    expect(await plane.submitPrompt(ctx('s-second'), { prompt: 'second', clientPromptId: 'msg-1' }, owner)).toMatchObject({ disposition: 'started' })
    expect(await plane.submitPrompt(ctx('s-first'), { prompt: 'first', clientPromptId: 'msg-1' }, owner)).toEqual({ disposition: 'duplicate' })
    expect(started).toHaveLength(2)
  })
})
