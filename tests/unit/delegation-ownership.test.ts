import { expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { CreateSessionOrder, OrchestratedRuntime, SpawnOrder } from '@solus/server/execution/orchestration/session-orders'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { SessionOrchestrator } = await import('@solus/server/execution/orchestration/session-orchestrator')

function harness() {
  const created: CreateSessionOrder[] = []
  const work: Promise<unknown>[] = []
  const stopped: string[] = []
  const runtime: OrchestratedRuntime = {
    activeExchangeIdsFor: () => ['parent-exchange'], queuedExchanges: () => [], sessionMeta: () => null,
    createSession: async order => { created.push(order); return { sessionId: order.sessionId! } },
    promptSession: async () => ({ disposition: 'started' }), stopSession: sessionId => { stopped.push(sessionId); return true },
    respondToPermission: () => false, pendingInputEvents: () => [], replaceQueuedPrompt: () => false,
    hasQueuedPrompt: () => false, cancelQueuedPrompt: () => false,
    turnEnding: async () => ({ outcome: 'completed', reply: 'Done' }),
    turnOrganization: async () => undefined, taskIdFor: async () => undefined, isLead: async () => false,
    emit: () => {}, invalidatePlanCaches: () => {}, recordActivity: async () => { throw new Error('No activity expected') },
    trackWork: promise => { work.push(promise); return promise },
  }
  const orchestrator = new SessionOrchestrator(runtime, { findPullRequest: async () => null })
  return { orchestrator, created, stopped, drain: () => Promise.all(work) }
}
const order: SpawnOrder = { prompt: 'Do work', provider: 'codex', modelId: 'test', reasoningEffort: 'medium', contextWindow: null, cwd: '/fixture' }

test('only delegated children hold the parent open and belong to its stop tree', async () => {
  const { orchestrator, created, drain } = harness()
  const child = await orchestrator.spawn('parent', order, true, 0, 'child')
  const independent = await orchestrator.spawn('parent', { ...order, independent: true }, true, 0, 'independent')
  await drain()
  expect(created[0]?.delegation?.parentSessionId).toBe('parent')
  expect(created[1]?.delegation).toBeUndefined()
  expect(created[1]?.sourceSessionId).toBe('parent')
  expect(orchestrator.childrenAtWork('parent')).toEqual([child.sessionId])
  expect(orchestrator.readExchange('parent', child.exchangeId)?.parentExchangeIds).toEqual(['parent-exchange'])
  expect(orchestrator.readExchange('parent', independent.exchangeId)?.parentExchangeIds).toEqual([])
  expect(orchestrator.isAwaitingReplies('parent')).toBe(true)
  orchestrator.cancelSentBy('parent')
  expect(orchestrator.readExchange('parent', child.exchangeId)?.outcome).toBe('interrupted')
  expect(orchestrator.readExchange('parent', independent.exchangeId)?.outcome).toBeUndefined()
  expect(orchestrator.isAwaitingReplies('parent')).toBe(false)
})

test('a retry preserves child identity and cannot switch to an independent launch', async () => {
  const { orchestrator, created, drain } = harness()
  const first = await orchestrator.spawn('parent', order, true, 0, 'same')
  const retry = await orchestrator.spawn('parent', order, true, 0, 'same')
  expect(retry.sessionId).toBe(first.sessionId)
  await expect(orchestrator.spawn('parent', { ...order, independent: true }, true, 0, 'same')).rejects.toThrow()
  await drain()
  expect(created).toHaveLength(1)
})

test('parent stop reaches nested children even without reports, but excludes independent sessions', async () => {
  const { orchestrator, stopped, drain } = harness()
  const child = await orchestrator.spawn('parent', order, false)
  const grandchild = await orchestrator.spawn(child.sessionId, order, false)
  await orchestrator.spawn(child.sessionId, { ...order, independent: true }, true)
  await drain()
  expect(orchestrator.isAwaitingReplies('parent')).toBe(false)
  orchestrator.stopChildren('parent', orchestrator.childrenAtWork('parent'))
  expect(stopped).toEqual([child.sessionId, grandchild.sessionId])
})
