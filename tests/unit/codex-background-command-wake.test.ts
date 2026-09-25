import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/agents/codex/codex-backend')['CodexBackend']
let codexBackgroundCommandWake: typeof import('@solus/server/agents/codex/codex-utils')['codexBackgroundCommandWake']
beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/agents/codex/codex-backend'))
  ;({ codexBackgroundCommandWake } = await import('@solus/server/agents/codex/codex-utils'))
})

type BackendInternals = {
  runningCommandThreads: Map<string, string>
  activeRuns: Map<string, unknown>
  onNotification: (msg: { method: string; params: unknown }, client: unknown) => void
}

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
    internals.runningCommandThreads.set('item-1', 'thread-1')

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
    internals.runningCommandThreads.set('item-2', 'thread-1')
    internals.activeRuns.set('thread-1', { normalizer: { push: () => [], summary: { toolCallCount: 0 } }, threadId: 'thread-1' })
    backend.on('normalized', () => {})

    internals.onNotification(completed('item-2'), {})

    expect(wakes).toEqual([])
    expect(internals.runningCommandThreads.has('item-2')).toBe(false)
  })

  test('the wake text keeps the command short and the output tail', () => {
    const text = codexBackgroundCommandWake({ command: 'x'.repeat(500), exitCode: null, aggregatedOutput: `${'a'.repeat(5_000)}END` })
    expect(text).not.toContain('(exit')
    expect(text).toContain(`${'x'.repeat(400)}…`)
    expect(text.endsWith('END')).toBe(true)
  })
})
