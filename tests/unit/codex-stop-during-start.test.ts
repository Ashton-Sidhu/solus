import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
})

const request: AgentRunRequest = {
  provider: 'codex', prompt: 'Build it', cwd: '/tmp/project', tools: [],
  model: 'gpt-5.6-sol', reasoningEffort: 'high', permissionMode: 'full-access',
  persistence: 'ephemeral', service: 'sessions', conversation: { kind: 'start' },
}

/** Answers every request at once, except `held`, which waits until the test releases it. */
function heldClient(held: string, response: object) {
  const requests: Array<{ method: string; params: { threadId?: string; turnId?: string } }> = []
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const interrupted = Promise.withResolvers<void>()
  const client = {
    requests,
    reached: reached.promise,
    interrupted: interrupted.promise,
    release: () => release.resolve(),
    request: async (method: string, params: { threadId?: string; turnId?: string }) => {
      requests.push({ method, params })
      if (method === held) {
        reached.resolve()
        await release.promise
        return response
      }
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      if (method === 'turn/interrupt') interrupted.resolve()
      return {}
    },
  }
  return client
}

describe('Codex Stop before the turn starts', () => {
  test('Stop during thread/start settles the run so its app-server and launcher are released', async () => {
    const backend = new CodexBackend()
    const client = heldClient('thread/start', { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' })
    Reflect.set(backend, 'client', client)
    const exits: Array<string | null> = []
    backend.on('exit', (_sessionId: string | null, _code: number | null, signal: string | null) => exits.push(signal))

    const handle = backend.startRun(request)
    await client.reached
    // A pending run has no thread id yet, so Stop aborts its handle directly.
    handle.abortController.abort()
    client.release()

    await handle.runPromise
    expect(backend.isSessionRunning('thread-1')).toBe(false)
    expect(backend.getPendingHandles()).toHaveLength(0)
    expect(exits).toEqual(['SIGINT'])
    expect(client.requests.map((entry) => entry.method)).not.toContain('turn/start')
  })

  test('Stop during turn/start interrupts the turn once its id is known', async () => {
    const backend = new CodexBackend()
    const client = heldClient('turn/start', { turn: { id: 'turn-1' } })
    Reflect.set(backend, 'client', client)

    backend.startRun(request)
    await client.reached
    expect(backend.cancelSession('thread-1')).toBe(true)
    expect(client.requests.map((entry) => entry.method)).not.toContain('turn/interrupt')
    client.release()

    await client.interrupted
    expect(client.requests.find((entry) => entry.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
  })
})
