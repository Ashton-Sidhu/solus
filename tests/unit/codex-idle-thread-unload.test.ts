import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let CodexRpcError: typeof import('@solus/server/execution/agents/codex/codex-agent')['CodexRpcError']
beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ CodexRpcError } = await import('@solus/server/execution/agents/codex/codex-agent'))
})
afterEach(() => jest.useRealTimers())

const IDLE_MS = 10 * 60_000

type FakeClient = { request: (method: string, params: unknown) => Promise<unknown>; calls: Array<[string, unknown]> }
type RunLike = { agentSessionId: string; threadId: string; client: FakeClient }
type BackendInternals = {
  client: FakeClient
  activeRuns: Map<string, RunLike>
  pendingRuns: RunLike[]
  runningCommands: Map<string, { threadId: string; processId: string | null; client: FakeClient; isBackground: boolean }>
  finishRun: (handle: RunLike) => void
  readThread: (threadId: string) => Promise<unknown>
  onNotification: (msg: { method: string; params: unknown }, client: unknown) => void
}

function fakeClient(answer: (method: string) => unknown = () => ({ status: 'unsubscribed' })): FakeClient {
  const calls: Array<[string, unknown]> = []
  return { calls, request: async (method, params) => { calls.push([method, params]); return answer(method) } }
}

function backendWith(client = fakeClient()) {
  const backend = new CodexBackend()
  const internals = backend as unknown as BackendInternals
  internals.client = client
  return { backend, internals, client }
}

const unsubscribes = (client: FakeClient) => client.calls.filter(([method]) => method === 'thread/unsubscribe')

// WHY: every loaded Codex thread runs its own copy of each stdio MCP server on
// the shared app-server. A thread that finished and was left alone (a delegated
// child, an old session someone previewed) kept them until the host restarted.
describe('Codex idle thread unload', () => {
  test('a thread left idle after its turn is unloaded from the app-server it ran on', async () => {
    jest.useFakeTimers()
    const { internals } = backendWith()
    const seatClient = fakeClient()
    internals.finishRun({ agentSessionId: 'thread-1', threadId: 'thread-1', client: seatClient })

    jest.advanceTimersByTime(IDLE_MS - 1)
    expect(unsubscribes(seatClient)).toEqual([])
    jest.advanceTimersByTime(1)
    await Promise.resolve()

    expect(unsubscribes(seatClient)).toEqual([['thread/unsubscribe', { threadId: 'thread-1' }]])
    expect(unsubscribes(internals.client)).toEqual([])
  })

  test('a thread that has a run again when the clock ends stays loaded', async () => {
    jest.useFakeTimers()
    const { internals, client } = backendWith()
    internals.finishRun({ agentSessionId: 'thread-1', threadId: 'thread-1', client })
    internals.pendingRuns.push({ agentSessionId: 'thread-1', threadId: 'thread-1', client })

    jest.advanceTimersByTime(IDLE_MS)
    await Promise.resolve()

    expect(unsubscribes(client)).toEqual([])
  })

  // Unloading a thread kills its terminals, so a command left running in the
  // background keeps the thread loaded until it settles.
  test('background work keeps a thread loaded, and its end starts the clock', async () => {
    jest.useFakeTimers()
    const { backend, internals, client } = backendWith()
    backend.on('normalized', () => {})
    backend.on('background-command-completed', () => {})
    internals.runningCommands.set('item-1', { threadId: 'thread-1', processId: 'proc-1', client, isBackground: true })
    internals.finishRun({ agentSessionId: 'thread-1', threadId: 'thread-1', client })

    jest.advanceTimersByTime(IDLE_MS)
    await Promise.resolve()
    expect(unsubscribes(client)).toEqual([])

    internals.onNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'item-1', command: 'sleep 1', exitCode: 0, aggregatedOutput: '' } },
    }, client)
    jest.advanceTimersByTime(IDLE_MS)
    await Promise.resolve()

    expect(unsubscribes(client)).toEqual([['thread/unsubscribe', { threadId: 'thread-1' }]])
  })

  test('a preview that had to load a dormant thread unloads it again', async () => {
    jest.useFakeTimers()
    const client = fakeClient((method) => {
      if (method === 'thread/read') throw new CodexRpcError('thread not loaded: thread-1', -32600)
      return method === 'thread/resume' ? { thread: { id: 'thread-1', turns: [] } } : { status: 'unsubscribed' }
    })
    const { internals } = backendWith(client)

    await internals.readThread('thread-1')
    jest.advanceTimersByTime(IDLE_MS)
    await Promise.resolve()

    expect(client.calls.map(([method]) => method)).toEqual(['thread/read', 'thread/resume', 'thread/unsubscribe'])
  })
})
