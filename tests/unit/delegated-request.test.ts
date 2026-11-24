import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { OrchestratedRuntime } from '@solus/server/execution/orchestration/session-orchestrator'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))
let SessionOrchestrator: typeof import('@solus/server/execution/orchestration/session-orchestrator')['SessionOrchestrator']
beforeAll(async () => {
  ;({ SessionOrchestrator } = await import('@solus/server/execution/orchestration/session-orchestrator'))
})

// WHY: a session that an agent started has no row in the sidebar and often no
// tab, but its question holds the work of the session that started it. The
// row of that session must say that a person must answer, on every client,
// so the host gives the fact to the parent (`delegatedRequest`).

const QUESTION: NormalizedEvent = {
  type: 'question_request', questionId: 'q-1',
  questions: [{ question: 'Which store?', options: [{ label: 'Host' }, { label: 'Account' }], multiSelect: false }],
}
const PERMISSION: NormalizedEvent = {
  type: 'permission_request', questionId: 'p-1', toolName: 'Bash', toolDescription: 'Run a command', toolInput: {}, options: [],
}

function fixture() {
  const changed: string[] = []
  const runtime: OrchestratedRuntime = {
    activeExchangeIdsFor: () => [], queuedExchanges: () => [],
    sessionMeta: () => null,
    createSession: async (order) => ({ sessionId: order.sessionId! }),
    promptSession: async () => ({ disposition: 'started' }),
    releaseRateLimit: () => false, stopSession: () => false, respondToPermission: () => false,
    pendingInputEvents: () => [], replaceQueuedPrompt: () => false,
    hasQueuedPrompt: () => false, cancelQueuedPrompt: () => false,
    turnEnding: async () => ({}), taskIdFor: async () => undefined,
    turnOrganization: async () => undefined,
    codebase: async () => null,
    emit: () => {}, invalidatePlanCaches: () => {},
    recordActivity: async () => { throw new Error('No person acted in this test') },
    trackWork: (promise) => promise,
    repliesEnded: () => {},
    delegatedRequestChanged: (sessionId) => { changed.push(sessionId) },
  }
  const orchestrator = new SessionOrchestrator(runtime, { findPullRequest: async () => null })
  const order = { prompt: 'Review the parser', provider: 'codex' as const, modelId: 'gpt-test', reasoningEffort: 'medium' as const, contextWindow: null, cwd: '/fixture', codebaseId: null }
  /** `sender` starts a session and its first turn runs. */
  const start = async (sender: string, options: { independent?: boolean } = {}) => {
    const spawned = await orchestrator.spawn(sender, { ...order, ...options }, true)
    const run = { sessionId: spawned.sessionId, runId: `run-${spawned.sessionId}`, exchangeIds: [spawned.exchangeId] }
    orchestrator.runStarted(run)
    return run
  }
  return { orchestrator, changed, start }
}

describe('what a started session waits on the person for', () => {
  test('the parent waits while its child asks, and stops when the person answers', async () => {
    const { orchestrator, changed, start } = fixture()
    const child = await start('parent')
    expect(orchestrator.delegatedRequestOf('parent')).toBeUndefined()

    orchestrator.inputRequested(child, QUESTION)
    expect(orchestrator.delegatedRequestOf('parent')).toBe('question')
    expect(changed).toEqual(['parent'])

    orchestrator.inputResolved(child, { kind: 'question', questions: [{ question: 'Which store?' }], answers: { 'Which store?': 'Host' } })
    expect(orchestrator.delegatedRequestOf('parent')).toBeUndefined()
    expect(changed).toEqual(['parent', 'parent'])
  })

  test('a request deeper down reaches every session above it', async () => {
    const { orchestrator, changed, start } = fixture()
    const child = await start('parent')
    const grandchild = await start(child.sessionId)

    orchestrator.inputRequested(grandchild, PERMISSION)
    expect(orchestrator.delegatedRequestOf(child.sessionId)).toBe('permission')
    expect(orchestrator.delegatedRequestOf('parent')).toBe('permission')
    expect(changed).toEqual([child.sessionId, 'parent'])
  })

  test('a permission outranks a question, as the sidebar ranks them', async () => {
    const { orchestrator, start } = fixture()
    const asking = await start('parent')
    const approving = await start('parent')
    orchestrator.inputRequested(asking, QUESTION)
    orchestrator.inputRequested(approving, PERMISSION)
    expect(orchestrator.delegatedRequestOf('parent')).toBe('permission')
  })

  test('the wait ends when the child is stopped while it asks', async () => {
    const { orchestrator, changed, start } = fixture()
    const child = await start('parent')
    orchestrator.inputRequested(child, QUESTION)
    changed.length = 0

    orchestrator.runCancelled(child)
    expect(orchestrator.delegatedRequestOf('parent')).toBeUndefined()
    expect(changed).toEqual(['parent'])
  })

  test('an independent session has its own row, so its request is not the parent\'s', async () => {
    const { orchestrator, changed, start } = fixture()
    const independent = await start('parent', { independent: true })
    orchestrator.inputRequested(independent, QUESTION)
    expect(orchestrator.delegatedRequestOf('parent')).toBeUndefined()
    expect(changed).toEqual([])
  })
})
