import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { TurnStop } from '@solus/server/execution/sessions/turn-stops'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
})

// t3code #27252: a Codex agent that ignores Stop kept its run until a
// `turn/completed` that may never come; a second Stop did nothing.
const request: AgentRunRequest = {
  provider: 'codex', prompt: 'Build it', cwd: '/tmp/project', tools: [],
  model: 'gpt-5.6-sol', reasoningEffort: 'high', permissionMode: 'full-access',
  persistence: 'ephemeral', service: 'sessions', conversation: { kind: 'start' },
}

/** An app-server whose `turn/interrupt` succeeds, but which never ends the turn. */
function ignoringClient() {
  const requests: string[] = []
  let turns = 0
  return {
    requests,
    request: async (method: string) => {
      requests.push(method)
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      return {}
    },
  }
}

async function runningTurn(stopConfirmTimeoutMs: number) {
  const backend = new CodexBackend()
  const client = ignoringClient()
  Reflect.set(backend, 'client', client)
  Reflect.set(backend, 'stopConfirmTimeoutMs', stopConfirmTimeoutMs)
  const exits: Array<[string, number | null, string | null]> = []
  backend.on('exit', (sessionId: string, code: number | null, signal: string | null) => { exits.push([sessionId, code, signal]) })
  const handle = backend.startRun(request)
  while (!client.requests.includes('turn/start')) await Bun.sleep(1)
  await Bun.sleep(5)
  let settled = false
  void handle.runPromise.then(() => { settled = true }, () => { settled = true })
  return { backend, client, exits, isSettled: () => settled }
}

describe('Stop on a Codex agent that ignores it', () => {
  test('Stop is bounded: the run settles as interrupted, and nothing is killed', async () => {
    const { backend, client, exits, isSettled } = await runningTurn(20)
    expect(backend.cancelSession('thread-1')).toBe(true)
    expect(client.requests).toContain('turn/interrupt')
    await Bun.sleep(5)
    expect(backend.isSessionRunning('thread-1')).toBe(true)
    await Bun.sleep(40)
    expect(backend.isSessionRunning('thread-1')).toBe(false)
    expect(isSettled()).toBe(true)
    expect(exits).toEqual([['thread-1', null, 'SIGINT']])
    expect(client.requests).not.toContain('thread/unsubscribe')
  })

  test('a second Stop force stops the turn at once, by unloading only its thread', async () => {
    const { backend, client, exits, isSettled } = await runningTurn(60_000)
    expect(backend.cancelSession('thread-1')).toBe(true)
    expect(backend.cancelSession('thread-1')).toBe(true)
    await Bun.sleep(5)
    expect(client.requests.filter((method) => method === 'thread/unsubscribe')).toHaveLength(1)
    expect(backend.isSessionRunning('thread-1')).toBe(false)
    expect(isSettled()).toBe(true)
    expect(exits).toEqual([['thread-1', null, 'SIGINT']])
  })

  test('the next prompt on the thread force stops the turn that ignored Stop before it resumes', async () => {
    const { backend, client } = await runningTurn(10)
    backend.cancelSession('thread-1')
    await Bun.sleep(30)
    expect(backend.isSessionRunning('thread-1')).toBe(false)
    backend.startRun({ ...request, conversation: { kind: 'resume', threadId: 'thread-1' } })
    while (client.requests.filter((method) => method === 'turn/start').length < 2) await Bun.sleep(1)
    const unload = client.requests.indexOf('thread/unsubscribe')
    expect(unload).toBeGreaterThan(-1)
    expect(unload).toBeLessThan(client.requests.indexOf('thread/resume'))
  })

  test('a second Stop reaches the work that ignored the first', () => {
    const stop = new TurnStop()
    let cancels = 0
    stop.onStop(() => { cancels++; return true })
    expect(stop.stop()).toBe(true)
    expect(stop.signal.aborted).toBe(true)
    expect(stop.stop()).toBe(true)
    expect(cancels).toBe(2)
  })

  test('Stop on a phase that has ended does nothing', () => {
    const stop = new TurnStop()
    const release = stop.onStop(() => true)
    expect(stop.stop()).toBe(true)
    release()
    expect(stop.stop()).toBe(false)
  })
})

// t3code #25224: `turn/start` took any turn id, and `turn/completed` is routed
// by thread, so a stopped turn that Codex completed late ended the next run.
describe('Codex turn ownership across runs on one thread', () => {
  test('a stopped earlier turn completing late does not finish the next run', async () => {
    const backend = new CodexBackend()
    let turnN = 0
    let releaseTurn2!: () => void
    const turn2Held = new Promise<void>((resolve) => { releaseTurn2 = resolve })
    const client = {
      request: async (method: string) => {
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
        if (method === 'turn/start') {
          turnN++
          if (turnN === 2) await turn2Held
          return { turn: { id: `turn-${turnN}` } }
        }
        return {}
      },
    }
    Reflect.set(backend, 'client', client)
    const internals = backend as unknown as { onNotification(m: { method: string; params: object }, c: unknown): void }

    backend.startRun(request)
    while (turnN < 1) await Bun.sleep(1)
    await Bun.sleep(5)
    backend.cancelSession('thread-1') // Codex has not yet sent turn/completed for turn-1

    const run2 = backend.startRun({ ...request, conversation: { kind: 'resume', threadId: 'thread-1' } })
    while (turnN < 2) await Bun.sleep(1)
    let run2Settled = false
    void run2.runPromise.then(() => { run2Settled = true })

    // The earlier turn's late completion arrives while run 2's turn/start is in flight.
    internals.onNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }, client)
    await Bun.sleep(5)
    releaseTurn2()
    await Bun.sleep(5)
    expect(run2Settled).toBe(false)
    expect(backend.isSessionRunning('thread-1')).toBe(true)

    // Run 2's own completion still ends it.
    internals.onNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } } }, client)
    await Bun.sleep(5)
    expect(run2Settled).toBe(true)
  })

  test('turn/start that answers with a turn an earlier run started fails the run', async () => {
    const backend = new CodexBackend()
    const client = {
      request: async (method: string) => {
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
        if (method === 'turn/start') return { turn: { id: 'turn-1' } }
        return {}
      },
    }
    Reflect.set(backend, 'client', client)
    const run1 = backend.startRun(request)
    await Bun.sleep(10)
    backend.cancelSession('thread-1')
    const errors: string[] = []
    backend.on('error', (_sessionId: string | null, error: Error) => { errors.push(error.message) })
    const run2 = backend.startRun({ ...request, conversation: { kind: 'resume', threadId: 'thread-1' } })
    await expect(run2.runPromise).rejects.toThrow('which an earlier run started')
    expect(errors).toHaveLength(1)
    void run1
  })
})
