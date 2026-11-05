import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let CodexRpcError: typeof import('@solus/server/execution/agents/codex/codex-agent')['CodexRpcError']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ CodexRpcError } = await import('@solus/server/execution/agents/codex/codex-agent'))
})

const request: AgentRunRequest = {
  provider: 'codex', prompt: 'Build it', cwd: '/tmp/project', tools: [],
  model: 'gpt-5.6-sol', reasoningEffort: 'high', permissionMode: 'full-access',
  persistence: 'ephemeral', service: 'sessions', conversation: { kind: 'start' },
}

/** Refuses `refused` with `failures` until a request succeeds, the way app-server refuses an archived thread. */
function refusingClient(refused: string, failures: Error[]) {
  const methods: string[] = []
  const reachedTurn = Promise.withResolvers<void>()
  return {
    methods,
    reachedTurn: reachedTurn.promise,
    request: async (method: string) => {
      methods.push(method)
      if (method === refused) {
        const failure = failures.shift()
        if (failure) throw failure
        return { thread: { id: 'thread-2' }, model: 'gpt-5.6-sol' }
      }
      if (method === 'turn/start') {
        reachedTurn.resolve()
        return { turn: { id: 'turn-1' } }
      }
      return {}
    },
  }
}

function archived(): Error {
  return new CodexRpcError('session thread-1 is archived. Run `codex unarchive thread-1` to unarchive it first.', -32600)
}

const runs = [
  { method: 'thread/fork', conversation: { kind: 'fork', sourceThreadId: 'thread-1' } },
  { method: 'thread/resume', conversation: { kind: 'resume', threadId: 'thread-1' } },
] as const

describe.each(runs)('a Codex thread archived outside Solus: $method', ({ method, conversation }) => {
  test('is unarchived and the request is sent once more', async () => {
    const backend = new CodexBackend()
    const client = refusingClient(method, [archived()])
    Reflect.set(backend, 'client', client)
    backend.startRun({ ...request, conversation })
    await client.reachedTurn
    expect(client.methods.filter((each) => each.startsWith('thread/'))).toEqual([method, 'thread/unarchive', method])
  })

  test('a second refusal ends the run: the retry happens once', async () => {
    const backend = new CodexBackend()
    backend.on('error', () => {})
    const client = refusingClient(method, [archived(), archived()])
    Reflect.set(backend, 'client', client)
    await backend.startRun({ ...request, conversation }).runPromise.catch(() => {})
    expect(client.methods).toEqual([method, 'thread/unarchive', method])
  })

  test('another refusal does not unarchive the thread', async () => {
    const backend = new CodexBackend()
    backend.on('error', () => {})
    const client = refusingClient(method, [new CodexRpcError('thread not found', -32600)])
    Reflect.set(backend, 'client', client)
    await backend.startRun({ ...request, conversation }).runPromise.catch(() => {})
    expect(client.methods).toEqual([method])
  })
})
