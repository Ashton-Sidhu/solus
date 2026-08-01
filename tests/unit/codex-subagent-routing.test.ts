import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('../../src/main/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('../../src/main/agents/codex/codex-backend'))
})

describe('CodexBackend subagent routing', () => {
  test('routes a spawned child thread back to its parent session', () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as {
      activeRuns: Map<string, { threadId: string }>
      rememberSessionRouting(params: unknown, sessionId: string): void
      sessionIdFor(params: unknown): string | null
    }
    internals.activeRuns.set('parent-thread', { threadId: 'parent-thread' })

    internals.rememberSessionRouting({
      threadId: 'parent-thread',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-1',
        kind: 'started',
        agentThreadId: 'child-thread',
      },
    }, 'parent-thread')

    // WHY: Codex emits the child's transcript under the child thread id. If
    // that id is not routed to the active parent run, every live child event is
    // discarded before the normalizer can attach it to the subagent card.
    expect(internals.sessionIdFor({ threadId: 'child-thread' })).toBe('parent-thread')
  })
})
