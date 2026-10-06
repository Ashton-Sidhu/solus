import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let codexBackgroundCommandWake: typeof import('@solus/server/execution/agents/codex/codex-utils')['codexBackgroundCommandWake']
beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ codexBackgroundCommandWake } = await import('@solus/server/execution/agents/codex/codex-utils'))
})

type RunningCommand = { threadId: string; processId: string | null; client: unknown; isBackground: boolean; isStopping?: boolean }
type BackendInternals = {
  runningCommands: Map<string, RunningCommand>
  activeRuns: Map<string, unknown>
  onNotification: (msg: { method: string; params: unknown }, client: unknown) => void
  finishCompletedTurn: (handle: unknown, normalized: NormalizedEvent[], partial: boolean, exitCode: 0 | 1 | null, exitSignal: 'SIGINT' | null, turnId: string) => Promise<void>
}

/** A command left running after its turn ended. */
const backgroundCommand = (client: unknown = {}): RunningCommand => ({ threadId: 'thread-1', processId: 'proc-1', client, isBackground: true })

const completed = (itemId: string) => ({
  method: 'item/completed',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'commandExecution', id: itemId, command: 'gh run watch 42', exitCode: 1, aggregatedOutput: 'lint failed\n' },
  },
})

describe('Codex background command wake', () => {
  // Codex reports a command that outlives its turn on the settled turn, which
  // no run owns. Without this the result was dropped and the agent never knew.
  test('a command that finishes after its turn ends wakes the session with its result', () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    const wakes: Array<[string, string]> = []
    backend.on('background-command-completed', (sessionId: string, prompt: string) => wakes.push([sessionId, prompt]))
    internals.runningCommands.set('item-1', backgroundCommand())

    internals.onNotification(completed('item-1'), {})

    expect(wakes).toEqual([['thread-1', codexBackgroundCommandWake({ command: 'gh run watch 42', exitCode: 1, aggregatedOutput: 'lint failed\n' })]])
    expect(wakes[0]![1]).toContain('(exit 1): gh run watch 42')
    expect(wakes[0]![1]).toContain('lint failed')
    // One completion wakes once.
    internals.onNotification(completed('item-1'), {})
    expect(wakes).toHaveLength(1)
  })

  test('a command that finishes while a turn runs is left to that turn', () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    const wakes: string[] = []
    backend.on('background-command-completed', (sessionId: string) => wakes.push(sessionId))
    internals.runningCommands.set('item-2', { ...backgroundCommand(), isBackground: false })
    internals.activeRuns.set('thread-1', { normalizer: { push: () => [], summary: { toolCallCount: 0 } }, threadId: 'thread-1' })
    backend.on('normalized', () => {})

    internals.onNotification(completed('item-2'), {})

    expect(wakes).toEqual([])
    expect(internals.runningCommands.has('item-2')).toBe(false)
  })

  // WHY: Codex ends its turn while the command runs on. Without the announce
  // the session read as finished, with no Stop, for work still going.
  test('a command still running when its turn ends becomes background work before the turn result', async () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    const events: string[] = []
    backend.on('normalized', (_sessionId: string, event: NormalizedEvent) => events.push(event.type))
    backend.on('exit', () => events.push('exit'))
    internals.runningCommands.set('item-3', { ...backgroundCommand(), isBackground: false })
    const handle = { agentSessionId: 'thread-1', persistent: false, _resolveRun: () => {} }
    internals.activeRuns.set('thread-1', handle)

    await internals.finishCompletedTurn(handle, [{ type: 'task_complete', result: '', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: 'thread-1' }], false, 0, null, 'turn-1')

    expect(events).toEqual(['background_task_started', 'task_complete', 'exit'])
    expect(backend.hasBackgroundTasks('thread-1')).toBe(true)
  })

  test('a background command that finishes settles its task, then wakes the agent', () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    const order: string[] = []
    backend.on('normalized', (_sessionId: string, event: NormalizedEvent) => {
      if (event.type === 'background_task_settled') order.push(`settled:${event.status}`)
    })
    backend.on('background-command-completed', () => order.push('wake'))
    internals.runningCommands.set('item-1', backgroundCommand())

    internals.onNotification(completed('item-1'), {})

    expect(order).toEqual(['settled:failed', 'wake'])
    expect(backend.hasBackgroundTasks('thread-1')).toBe(false)
  })

  // WHY: the person stopped the command. Waking the agent with its exit would
  // start a turn nobody asked for.
  test('a stopped command terminates its terminal and wakes nobody', async () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    const requests: Array<[string, unknown]> = []
    const client = { request: async (method: string, params: unknown) => { requests.push([method, params]); return { terminated: true } } }
    const settled: string[] = []
    const wakes: string[] = []
    backend.on('normalized', (_sessionId: string, event: NormalizedEvent) => {
      if (event.type === 'background_task_settled') settled.push(event.status)
    })
    backend.on('background-command-completed', (sessionId: string) => wakes.push(sessionId))
    internals.runningCommands.set('item-1', backgroundCommand(client))

    expect(await backend.stopBackgroundTask('thread-1', 'item-1')).toBe(true)
    // Codex still reports the killed command complete.
    internals.onNotification(completed('item-1'), {})

    expect(requests).toEqual([['thread/backgroundTerminals/terminate', { threadId: 'thread-1', processId: 'proc-1' }]])
    expect(settled).toEqual(['stopped'])
    expect(wakes).toEqual([])
  })

  test('cancelling a session with no turn running stops the commands its agent left', () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    const requests: string[] = []
    const client = { request: async (method: string) => { requests.push(method); return { terminated: true } } }
    internals.runningCommands.set('item-1', backgroundCommand(client))
    expect(backend.cancelSession('thread-1')).toBe(true)
    expect(requests).toEqual(['thread/backgroundTerminals/terminate'])
    expect(backend.cancelSession('thread-2')).toBe(false)
  })

  test('a command another session started is not stopped from this one', async () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    internals.runningCommands.set('item-1', backgroundCommand())
    expect(await backend.stopBackgroundTask('thread-2', 'item-1')).toBe(false)
    expect(internals.runningCommands.has('item-1')).toBe(true)
  })

  test('the wake text keeps the command short and the output tail', () => {
    const text = codexBackgroundCommandWake({ command: 'x'.repeat(500), exitCode: null, aggregatedOutput: `${'a'.repeat(5_000)}END` })
    expect(text).not.toContain('(exit')
    expect(text).toContain(`${'x'.repeat(400)}…`)
    expect(text.endsWith('END')).toBe(true)
  })
})
