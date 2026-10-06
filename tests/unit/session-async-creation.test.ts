import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { OrchestratedRuntime, CreateSessionOrder } from '@solus/server/execution/orchestration/session-orchestrator'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let SessionOrchestrator: typeof import('@solus/server/execution/orchestration/session-orchestrator')['SessionOrchestrator']
beforeAll(async () => {
  ;({ SessionOrchestrator } = await import('@solus/server/execution/orchestration/session-orchestrator'))
})

function fixture(previousReply?: string) {
  const startup = Promise.withResolvers<{ sessionId: string }>()
  const orders: CreateSessionOrder[] = []
  const updates: NormalizedEvent[] = []
  const prompts: string[] = []
  const work: Promise<void>[] = []
  const runtime: OrchestratedRuntime = {
    activeExchangeIdsFor: () => [], queuedExchanges: () => [],
    sessionMeta: () => null,
    createSession: (order) => { orders.push(order); return startup.promise },
    promptSession: async (_id, prompt) => { prompts.push(prompt); return { disposition: 'started' } },
    stopSession: () => false, respondToPermission: () => false,
    pendingInputEvents: () => [], replaceQueuedPrompt: () => false,
    hasQueuedPrompt: () => false, cancelQueuedPrompt: () => false,
    turnEnding: async () => (previousReply ? { reply: previousReply } : {}), taskIdFor: async () => undefined, isLead: async () => false,
    emit: (_id, event) => { updates.push(event) }, invalidatePlanCaches: () => {},
    recordActivity: async () => { throw new Error('No person acted in this test') },
    trackWork: (promise) => { work.push(promise.then(() => {})); return promise },
  }
  const orchestrator = new SessionOrchestrator(runtime, { findPullRequest: async () => null })
  const order = { prompt: 'Review the parser', provider: 'codex' as const, modelId: 'gpt-test', reasoningEffort: 'medium' as const, contextWindow: null, cwd: '/fixture' }
  const drain = async () => {
    for (let index = 0; index < work.length; index++) await work[index]
  }
  return { startup, orders, updates, prompts, orchestrator, order, drain }
}

describe('async session creation', () => {
  test('an explicit wait receives a startup failure without a second automatic report', async () => {
    const { startup, orders, prompts, orchestrator, order, drain } = fixture()
    const waiting = orchestrator.spawn('parent', order, true, 10_000)
    expect(orders).toHaveLength(1)
    startup.reject(new Error('Provider unavailable'))
    const result = await waiting
    await drain()
    expect(result.waited).toMatchObject({ type: 'report', report: { status: 'failed', reply: 'Session startup failed: Provider unavailable' } })
    expect(prompts).toEqual([])
  })

  test('returns an accepted exchange before provider initialization and retries do not duplicate work', async () => {
    const { startup, orders, updates, orchestrator, order, drain } = fixture()
    const accepted = await orchestrator.spawn('parent', order, true, 0, 'review-1')
    expect(accepted.starting).toBe(true)
    // WHY: the new session's id is chosen before its provider starts, so the
    // sender's card and its tools name the real session from the first moment.
    expect(accepted.sessionId).toBe(orders[0]!.sessionId!)
    expect(orchestrator.readExchange('parent', accepted.exchangeId)?.state).toBe('dispatched')
    expect(updates).toHaveLength(1)
    const retried = await orchestrator.spawn('parent', order, true, 0, 'review-1')
    expect(retried).toMatchObject({ exchangeId: accepted.exchangeId, sessionId: accepted.sessionId, starting: true })
    expect(orders).toHaveLength(1)
    startup.resolve({ sessionId: accepted.sessionId })
    await drain()
    expect(orchestrator.readExchange('parent', accepted.exchangeId)?.targetSessionId).toBe(accepted.sessionId)
  })

  test('reports startup failures once through the original exchange', async () => {
    const { startup, orders, prompts, orchestrator, order, drain } = fixture()
    const accepted = await orchestrator.spawn('parent', order, true, 0, 'review-1')
    startup.reject(new Error('Provider unavailable'))
    await drain()
    expect(orchestrator.readExchange('parent', accepted.exchangeId)).toMatchObject({
      state: 'settled', outcome: 'failed', report: { reply: 'Session startup failed: Provider unavailable' },
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Provider unavailable')
    await orchestrator.spawn('parent', order, true, 0, 'review-1')
    expect(orders).toHaveLength(1)
    expect(prompts).toHaveLength(1)
  })

  test('the final reply wakes the parent after asynchronous startup', async () => {
    const { startup, orders, prompts, orchestrator, order, drain } = fixture()
    const accepted = await orchestrator.spawn('parent', order, true)
    startup.resolve({ sessionId: orders[0]!.sessionId! })
    await drain()
    const run = { sessionId: orders[0]!.sessionId!, runId: 'child-run', exchangeIds: [accepted.exchangeId] }
    orchestrator.runStarted(run)
    orchestrator.runSettled({ ...run, provider: 'codex', outcome: 'completed', resultText: 'Review passed.' })
    await drain()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Review passed.')
    expect(orchestrator.readExchange('parent', accepted.exchangeId)?.state).toBe('settled')
  })

  test('report=false still creates asynchronously and keeps a readable failure without waking the parent', async () => {
    const { startup, prompts, orchestrator, order, drain } = fixture()
    const accepted = await orchestrator.spawn('parent', order, false)
    expect(accepted.starting).toBe(true)
    startup.reject(new Error('Startup failed'))
    await drain()
    expect(orchestrator.readExchange('parent', accepted.exchangeId)?.outcome).toBe('failed')
    expect(prompts).toEqual([])
  })
})

// WHY: a run that dies before it writes its prompt leaves the previous turn last
// in the transcript. Reading the reply from there told the sender the child had
// finished its old work, so the sender retried a session that could never start.
describe('a failed run reports why it failed', () => {
  async function startedChild(previousReply: string) {
    const fixture_ = fixture(previousReply)
    const accepted = await fixture_.orchestrator.spawn('parent', fixture_.order, true)
    fixture_.startup.resolve({ sessionId: fixture_.orders[0]!.sessionId! })
    await fixture_.drain()
    const run = { sessionId: fixture_.orders[0]!.sessionId!, runId: 'child-run', exchangeIds: [accepted.exchangeId] }
    return { ...fixture_, accepted, run }
  }

  test('its own error, never the previous turn\'s reply', async () => {
    const { orchestrator, accepted, run, drain } = await startedChild('Earlier work is done.')
    orchestrator.runStarted(run)
    orchestrator.runSettled({ ...run, provider: 'codex', outcome: 'failed', error: 'spawn ENOENT' })
    await drain()
    expect(orchestrator.readExchange('parent', accepted.exchangeId)).toMatchObject({
      state: 'settled', outcome: 'failed', report: { reply: 'The turn ended with an error: spawn ENOENT' },
    })
  })

  test('a run that could not start reports the reason', async () => {
    const { orchestrator, accepted, run, drain } = await startedChild('Earlier work is done.')
    const reason = 'The turn could not start: The working directory /gone no longer exists.'
    orchestrator.runCancelled(run, 'failed', reason)
    await drain()
    expect(orchestrator.readExchange('parent', accepted.exchangeId)).toMatchObject({
      state: 'settled', outcome: 'failed', report: { reply: reason },
    })
  })
})
