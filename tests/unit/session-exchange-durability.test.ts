import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionExchangeStore } from '@solus/server/data/sessions/session-exchange-store'
import { ExchangeLedger } from '@solus/server/execution/orchestration/exchange-ledger'
import { recoverExchanges } from '@solus/server/execution/orchestration/recover-exchanges'
import { ParentDelivery, type ParentDeliveryRuntime } from '@solus/server/execution/orchestration/parent-delivery'
import type { Exchange } from '@solus/server/execution/orchestration/exchange'
import type { OrchestratedRuntime } from '@solus/server/execution/orchestration/session-orchestrator'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function store() {
  const root = mkdtempSync(join(tmpdir(), 'solus-exchanges-'))
  roots.push(root)
  return new SessionExchangeStore(root)
}
function exchange(fields: Partial<Exchange> = {}): Exchange {
  return { exchangeId: 'request', kind: 'prompt', senderSessionId: 'A', senderAgentSessionId: 'thread-A',
    targetSessionId: 'B', targetAgentSessionId: 'thread-B', provider: 'codex', notify: true,
    state: 'running', runId: 'run-B', dispatchedAt: Date.now(), outputs: [], notices: [], revising: false, parentExchangeIds: [], ...fields }
}
function savedResult(fields: Partial<Exchange> = {}): Exchange {
  return exchange({ state: 'settled', outcome: 'completed', settledAt: Date.now(), deliveryState: 'pending',
    report: { messageId: 'request', agentSessionId: 'thread-B', status: 'completed', outputs: [], reply: 'Reviewed and done.' }, ...fields })
}
function delivery() {
  const prompts: string[] = []
  const work: Promise<unknown>[] = []
  const runtime: ParentDeliveryRuntime = {
    sessionIdFor: (id) => id,
    promptSession: async (_id, prompt) => { prompts.push(prompt); return { disposition: 'queued', queueId: 'report-queue' } },
    replaceQueuedPrompt: () => true, hasQueuedPrompt: () => true, cancelQueuedPrompt: () => true,
    trackWork: (promise) => { work.push(promise); return promise },
  }
  return { prompts, runtime, parent: new ParentDelivery(runtime, () => {}), drain: () => Promise.all(work) }
}
function recover(ledger: ExchangeLedger, queues: ReturnType<OrchestratedRuntime['queuedExchanges']> = []) {
  const outbox = delivery()
  const interrupted: string[] = []
  const delivered: string[] = []
  recoverExchanges({ queuedExchanges: () => queues }, ledger, outbox.parent,
    (item) => { interrupted.push(item.exchangeId); item.state = 'settled'; item.outcome = 'interrupted'; ledger.save(item) },
    (item) => { delivered.push(item.exchangeId) })
  return { interrupted, delivered, ...outbox }
}

describe('durable session exchanges', () => {
  for (const provider of ['claude-code', 'codex'] as const) {
    test(`${provider}: one receipt preserves result and pending delivery after restart`, () => {
      const storage = store()
      const ledger = new ExchangeLedger(storage)
      ledger.save(savedResult({ provider }))
      const restored = new ExchangeLedger(storage)
      expect(restored.read('A', 'request')).toMatchObject({ provider, state: 'settled', deliveryState: 'pending',
        report: { reply: 'Reviewed and done.' } })
      expect(restored.read('B', 'request')).toBeUndefined()
      expect(recover(restored).delivered).toEqual(['request'])
      expect(recover(restored).delivered).toEqual([])
    })
  }

  test('a queued report is reattached rather than submitted twice', () => {
    const storage = store()
    new ExchangeLedger(storage).save(savedResult())
    const ledger = new ExchangeLedger(storage)
    const recovery = recover(ledger, [{ sessionId: 'A', queueId: 'held-report', exchangeIds: [], reportExchangeIds: ['request'], started: false }])
    expect(recovery.delivered).toEqual([])
    expect(recovery.parent.waitingReports('thread-A')).toEqual([{ exchangeId: 'request', targetAgentSessionId: 'thread-B' }])
    expect(ledger.read('A', 'request')).toMatchObject({ deliveryState: 'queued', deliveryQueueId: 'held-report' })
    expect(recovery.prompts).toEqual([])
  })

  test('unstarted queued work stays open; uncertain running work is interrupted', () => {
    const storage = store()
    const ledger = new ExchangeLedger(storage)
    ledger.save(exchange())
    ledger.save(exchange({ exchangeId: 'queued', state: 'queued' }))
    const restored = new ExchangeLedger(storage)
    const recovery = recover(restored, [{ sessionId: 'B', queueId: 'held-work', exchangeIds: ['queued'], reportExchangeIds: [], started: false }])
    expect(recovery.interrupted).toEqual(['request'])
    expect(restored.read('A', 'queued')?.state).toBe('queued')
    expect(recovery.prompts).toEqual([])
  })

  test('work accepted after startup is outside restart recovery', () => {
    const ledger = new ExchangeLedger(store())
    const current = exchange()
    ledger.exchanges.set(current.exchangeId, current)
    ledger.save(current)
    expect(recover(ledger).interrupted).toEqual([])
    expect(current.state).toBe('running')
  })

  test('a restored parent waits for the child report that is still queued', () => {
    const storage = store()
    const ledger = new ExchangeLedger(storage)
    ledger.save(exchange({ state: 'waiting_for_children' }))
    ledger.save(savedResult({ exchangeId: 'child', senderSessionId: 'B', senderAgentSessionId: 'thread-B', targetSessionId: 'C',
      targetAgentSessionId: 'thread-C', parentExchangeIds: ['request'], report: { messageId: 'child', agentSessionId: 'thread-C', status: 'completed', outputs: [], reply: 'Review passed.' } }))
    const restored = new ExchangeLedger(storage)
    const recovery = recover(restored, [{ sessionId: 'B', queueId: 'followup', exchangeIds: ['request'], reportExchangeIds: ['child'], started: false }])
    expect(recovery.interrupted).toEqual([])
    expect(restored.read('A', 'request')?.state).toBe('waiting_for_children')
    expect(restored.hasChildren('request')).toBe(true)
  })

  test('a started completion follow-up has an uncertain outcome after restart', () => {
    const storage = store()
    new ExchangeLedger(storage).save(exchange())
    const restored = new ExchangeLedger(storage)
    expect(recover(restored, [{ sessionId: 'B', queueId: 'followup', exchangeIds: ['request'], reportExchangeIds: [], started: true }]).interrupted).toEqual(['request'])
  })

  test('a retry key is scoped to the caller and survives restart', () => {
    const storage = store()
    const ledger = new ExchangeLedger(storage)
    const first = ledger.identify('A', 'review-round-1', 'same work')
    const request = exchange({ exchangeId: first.exchangeId, fingerprint: first.fingerprint })
    ledger.save(request)
    const restored = new ExchangeLedger(storage)
    expect(restored.identify('A', 'review-round-1', 'same work').existing?.exchangeId).toBe(first.exchangeId)
    expect(restored.identify('B', 'review-round-1', 'same work').existing).toBeUndefined()
    expect(() => restored.identify('A', 'review-round-1', 'changed work')).toThrow('different work')
  })

  test('dependencies belong to a request, and remain open through report acceptance', () => {
    const ledger = new ExchangeLedger()
    const child = savedResult({ exchangeId: 'child', parentExchangeIds: ['request-one'] })
    ledger.exchanges.set('child', child)
    expect(ledger.hasChildren('request-one')).toBe(true)
    expect(ledger.hasChildren('request-two')).toBe(false)
    child.deliveryState = 'queued'
    expect(ledger.hasChildren('request-one')).toBe(true)
    child.deliveryState = 'accepted'
    expect(ledger.hasChildren('request-one')).toBe(false)
    child.state = 'running'
    child.notify = false
    expect(ledger.hasChildren('request-one')).toBe(false)
  })

  test('nested reported work cannot wait on an ancestor', () => {
    const ledger = new ExchangeLedger()
    ledger.exchanges.set('parent', exchange({ exchangeId: 'parent' }))
    ledger.exchanges.set('child', exchange({ exchangeId: 'child', senderSessionId: 'B', targetSessionId: 'C', parentExchangeIds: ['parent'] }))
    expect(ledger.isAncestor(['child'], 'A')).toBe(true)
    expect(ledger.isAncestor(['child'], 'D')).toBe(false)
  })
})
