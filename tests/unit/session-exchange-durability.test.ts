import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORCHESTRATION_LIMITS } from '@solus/contracts/session-exchange'
import type { Exchange } from '@solus/server/execution/orchestration/exchange'
import type { ParentDeliveryRuntime, RetrySchedule } from '@solus/server/execution/orchestration/parent-delivery'
import type { OrchestratedRuntime } from '@solus/server/execution/orchestration/session-orchestrator'
import type { SavedExchange } from '@solus/server/data/sessions/run-ledger'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let RunLedger: typeof import('@solus/server/data/sessions/run-ledger')['RunLedger']
let ExchangeLedger: typeof import('@solus/server/execution/orchestration/exchange-ledger')['ExchangeLedger']
let recoverExchanges: typeof import('@solus/server/execution/orchestration/recover-exchanges')['recoverExchanges']
let ParentDelivery: typeof import('@solus/server/execution/orchestration/parent-delivery')['ParentDelivery']
let DELIVERY_RETRY_DELAYS_MS: typeof import('@solus/server/execution/orchestration/parent-delivery')['DELIVERY_RETRY_DELAYS_MS']
let db: typeof import('@solus/server/db')
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-exchanges-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ RunLedger } = await import('@solus/server/data/sessions/run-ledger'))
  ;({ ExchangeLedger } = await import('@solus/server/execution/orchestration/exchange-ledger'))
  ;({ recoverExchanges } = await import('@solus/server/execution/orchestration/recover-exchanges'))
  ;({ ParentDelivery, DELIVERY_RETRY_DELAYS_MS } = await import('@solus/server/execution/orchestration/parent-delivery'))
  db = await import('@solus/server/db')
})
afterEach(() => { db.getDb().exec('DELETE FROM run_exchanges; DELETE FROM run_queue') })
afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function exchange(fields: Partial<Exchange> = {}): Exchange {
  return { exchangeId: 'request', kind: 'prompt', senderSessionId: 'A', senderAgentSessionId: 'thread-A',
    targetSessionId: 'B', targetAgentSessionId: 'thread-B', provider: 'codex', notify: true,
    state: 'running', runId: 'run-B', dispatchedAt: Date.now(), outputs: [], notices: [], revising: false, parentExchangeIds: [], ...fields }
}
function savedResult(fields: Partial<Exchange> = {}): Exchange {
  return exchange({ state: 'settled', outcome: 'completed', settledAt: Date.now(), deliveryState: 'pending',
    report: { messageId: 'request', agentSessionId: 'thread-B', status: 'completed', outputs: [], reply: 'Reviewed and done.' }, ...fields })
}
function delivery(schedule?: RetrySchedule) {
  const prompts: string[] = []
  const work: Promise<unknown>[] = []
  const recorded: Array<[string[], string]> = []
  const runtime: ParentDeliveryRuntime = {
    sessionIdFor: (id) => id,
    promptSession: async (_id, prompt) => { prompts.push(prompt); return { disposition: 'queued', queueId: 'report-queue' } },
    replaceQueuedPrompt: () => true, hasQueuedPrompt: () => true, cancelQueuedPrompt: () => true,
    trackWork: (promise) => { work.push(promise); return promise },
  }
  const parent = new ParentDelivery(runtime, (exchangeIds, state) => { recorded.push([exchangeIds, state]) }, schedule)
  return { prompts, runtime, parent, recorded, drain: async () => { while (work.length) await work.shift() } }
}
function recover(ledger: InstanceType<typeof ExchangeLedger>, queues: ReturnType<OrchestratedRuntime['queuedExchanges']> = []) {
  const outbox = delivery()
  const interrupted: string[] = []
  const delivered: string[] = []
  recoverExchanges({ queuedExchanges: () => queues }, ledger, outbox.parent,
    (item) => { interrupted.push(item.exchangeId); ledger.apply(item, { type: 'settled', outcome: 'interrupted' }) },
    (item) => { delivered.push(item.exchangeId) })
  return { interrupted, delivered, ...outbox }
}

describe('durable session exchanges', () => {
  for (const provider of ['claude-code', 'codex'] as const) {
    test(`${provider}: one receipt preserves result and pending delivery after restart`, () => {
      const ledger = new ExchangeLedger(new RunLedger())
      ledger.open(savedResult({ provider }))
      const restored = new ExchangeLedger(new RunLedger())
      expect(restored.read('A', 'request')).toMatchObject({ provider, state: 'settled', deliveryState: 'pending',
        report: { reply: 'Reviewed and done.' } })
      expect(restored.read('B', 'request')).toBeUndefined()
      expect(recover(restored).delivered).toEqual(['request'])
      expect(recover(restored).delivered).toEqual([])
    })
  }

  test('a full reply survives restart; only the model report is bounded', () => {
    const reply = `${'Finding. '.repeat(555)}The last line matters.`
    expect(reply.length).toBeGreaterThan(5_000)
    new ExchangeLedger(new RunLedger()).open(savedResult({
      report: { messageId: 'request', agentSessionId: 'thread-B', status: 'completed', outputs: [], reply } }))
    const restored = new ExchangeLedger(new RunLedger()).read('A', 'request')
    expect(restored?.report?.reply).toBe(reply)
    const row = db.getDb().prepare('SELECT report, reply FROM run_exchanges').get() as { report: string; reply: string }
    expect(row.reply).toBe(reply)
    expect(row.report).not.toContain('The last line matters.')
    expect(row.report.length).toBeLessThan(ORCHESTRATION_LIMITS.reply + 400)
  })

  test('a failed write leaves the exchange open in memory, as it is on disk', () => {
    class FailingLedger extends RunLedger {
      fail = false
      override saveExchanges(records: readonly SavedExchange[]): void {
        if (this.fail) throw new Error('Disk full')
        super.saveExchanges(records)
      }
    }
    const store = new FailingLedger()
    const ledger = new ExchangeLedger(store)
    const open = exchange()
    ledger.open(open)
    store.fail = true
    expect(() => ledger.apply(open, { type: 'settled', runId: 'run-B', outcome: 'completed' })).toThrow('Disk full')
    expect(open.state).toBe('running')
    expect(open.outcome).toBeUndefined()
    expect(() => ledger.markDelivery(['request'], 'disposed')).toThrow('Disk full')
    expect(open.deliveryState).toBeUndefined()
    expect(new ExchangeLedger(new RunLedger()).read('A', 'request')?.state).toBe('running')
    store.fail = false
    expect(ledger.apply(open, { type: 'settled', runId: 'run-B', outcome: 'completed' })).toBe(true)
    expect(new ExchangeLedger(new RunLedger()).read('A', 'request')?.state).toBe('settled')
  })

  test('a command keeps the waiting tool call with the live exchange', () => {
    const ledger = new ExchangeLedger(new RunLedger())
    const open = exchange()
    ledger.open(open)
    const wait = { resolve: () => {}, timer: setTimeout(() => {}, 0) }
    open.wait = wait
    ledger.apply(open, { type: 'rate_limited' })
    expect(open.state).toBe('rate_limited')
    expect(open.wait).toBe(wait)
    clearTimeout(wait.timer)
  })

  test('a queued prompt takes over report delivery in the same transaction', () => {
    const store = new RunLedger()
    const ledger = new ExchangeLedger(store)
    ledger.open(savedResult({ exchangeId: 'child' }))
    const prompt = { queueId: 'report-prompt', sessionId: 'A', prompt: 'Child result', enqueuedAt: 1, reason: 'busy' as const,
      revision: 0, kind: 'prompt' as const, held: false, reportExchangeIds: ['child'],
      input: { provider: 'codex' as const, agentSessionId: 'thread-A', workingDirectory: '/tmp/project', projectPath: '/tmp/project',
        model: 'gpt-6-astra', preferredModel: null, permissionMode: 'supervised' as const, reasoningEffort: 'medium' as const,
        contextWindow: null, fastMode: false, extraInstructions: '', forked: false, additionalDirs: [], sessionChangedFiles: [],
        rateLimitBehavior: 'ask' as const, worktreeBaseBranch: null },
      options: { prompt: 'Child result' } }
    // The second row repeats the queue id, so the queue write fails after the
    // delivery change: neither may commit.
    expect(() => store.saveQueue('A', [prompt, { ...prompt }])).toThrow()
    expect(new ExchangeLedger(new RunLedger()).read('A', 'child')?.deliveryState).toBe('pending')
    expect(new RunLedger().loadQueue()).toEqual([])
    expect(ledger.read('A', 'child')?.deliveryState).toBe('pending')

    store.saveQueue('A', [prompt])
    expect(ledger.read('A', 'child')).toMatchObject({ deliveryState: 'queued', deliveryQueueId: 'report-prompt' })
    expect(new ExchangeLedger(new RunLedger()).read('A', 'child')).toMatchObject({ deliveryState: 'queued', deliveryQueueId: 'report-prompt' })
    expect(new RunLedger().loadQueue().map((entry) => entry.queueId)).toEqual(['report-prompt'])
  })

  test('a queued report is reattached rather than submitted twice', () => {
    new ExchangeLedger(new RunLedger()).open(savedResult())
    const ledger = new ExchangeLedger(new RunLedger())
    const recovery = recover(ledger, [{ sessionId: 'A', queueId: 'held-report', exchangeIds: [], reportExchangeIds: ['request'], started: false }])
    expect(recovery.delivered).toEqual([])
    expect(recovery.parent.waitingReports('thread-A')).toEqual([{ exchangeId: 'request', targetAgentSessionId: 'thread-B' }])
    expect(ledger.read('A', 'request')).toMatchObject({ deliveryState: 'queued', deliveryQueueId: 'held-report' })
    expect(recovery.prompts).toEqual([])
  })

  test('unstarted queued work stays open; uncertain running work is interrupted', () => {
    const ledger = new ExchangeLedger(new RunLedger())
    ledger.open(exchange())
    ledger.open(exchange({ exchangeId: 'queued', state: 'queued' }))
    const restored = new ExchangeLedger(new RunLedger())
    const recovery = recover(restored, [{ sessionId: 'B', queueId: 'held-work', exchangeIds: ['queued'], reportExchangeIds: [], started: false }])
    expect(recovery.interrupted).toEqual(['request'])
    expect(restored.read('A', 'queued')?.state).toBe('queued')
    expect(recovery.prompts).toEqual([])
  })

  test('work accepted after startup is outside restart recovery', () => {
    const ledger = new ExchangeLedger(new RunLedger())
    const current = exchange()
    ledger.open(current)
    expect(recover(ledger).interrupted).toEqual([])
    expect(current.state).toBe('running')
  })

  test('a restored parent waits for the child report that is still queued', () => {
    const ledger = new ExchangeLedger(new RunLedger())
    ledger.open(exchange({ state: 'waiting_for_children' }))
    ledger.open(savedResult({ exchangeId: 'child', senderSessionId: 'B', senderAgentSessionId: 'thread-B', targetSessionId: 'C',
      targetAgentSessionId: 'thread-C', parentExchangeIds: ['request'], report: { messageId: 'child', agentSessionId: 'thread-C', status: 'completed', outputs: [], reply: 'Review passed.' } }))
    const restored = new ExchangeLedger(new RunLedger())
    const recovery = recover(restored, [{ sessionId: 'B', queueId: 'followup', exchangeIds: ['request'], reportExchangeIds: ['child'], started: false }])
    expect(recovery.interrupted).toEqual([])
    expect(restored.read('A', 'request')?.state).toBe('waiting_for_children')
    expect(restored.hasChildren('request')).toBe(true)
  })

  test('a started completion follow-up has an uncertain outcome after restart', () => {
    new ExchangeLedger(new RunLedger()).open(exchange())
    const restored = new ExchangeLedger(new RunLedger())
    expect(recover(restored, [{ sessionId: 'B', queueId: 'followup', exchangeIds: ['request'], reportExchangeIds: [], started: true }]).interrupted).toEqual(['request'])
  })

  test('a retry key is scoped to the caller and survives restart', () => {
    const ledger = new ExchangeLedger(new RunLedger())
    const first = ledger.identify('A', 'review-round-1', 'same work')
    ledger.open(exchange({ exchangeId: first.exchangeId, fingerprint: first.fingerprint }))
    const restored = new ExchangeLedger(new RunLedger())
    expect(restored.identify('A', 'review-round-1', 'same work').existing?.exchangeId).toBe(first.exchangeId)
    expect(restored.identify('B', 'review-round-1', 'same work').existing).toBeUndefined()
    expect(() => restored.identify('A', 'review-round-1', 'changed work')).toThrow('different work')
  })

  test('closed receipts leave after thirty days; undelivered results stay', () => {
    const old = Date.now() - 31 * 86_400_000
    const ledger = new ExchangeLedger(new RunLedger())
    ledger.open(savedResult({ exchangeId: 'closed', settledAt: old, deliveryState: 'accepted' }))
    ledger.open(savedResult({ exchangeId: 'undelivered', settledAt: old }))
    const restored = new ExchangeLedger(new RunLedger())
    expect(restored.read('A', 'closed')).toBeUndefined()
    expect(restored.read('A', 'undelivered')?.deliveryState).toBe('pending')
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

describe('report delivery retries while the host runs', () => {
  const report = { exchangeId: 'child', targetAgentSessionId: 'thread-B',
    item: { type: 'report' as const, report: { messageId: 'child', agentSessionId: 'thread-B', status: 'completed' as const, outputs: [], reply: 'Done.' } } }
  const locked = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })

  test('a transient failure is tried again after a growing delay, then delivered once', async () => {
    const retries: Array<{ delayMs: number; retry: () => void }> = []
    const outbox = delivery((delayMs, retry) => { retries.push({ delayMs, retry }) })
    const submit = outbox.runtime.promptSession
    let failures = 2
    outbox.runtime.promptSession = async (...args) => {
      if (failures-- > 0) throw locked()
      return submit(...args)
    }
    outbox.parent.deliver('thread-A', report)
    await outbox.drain()
    expect(retries.map((retry) => retry.delayMs)).toEqual([DELIVERY_RETRY_DELAYS_MS[0]])
    expect(outbox.recorded).toEqual([])
    retries.shift()!.retry()
    await outbox.drain()
    expect(retries.map((retry) => retry.delayMs)).toEqual([DELIVERY_RETRY_DELAYS_MS[1]])
    retries.shift()!.retry()
    await outbox.drain()
    expect(outbox.prompts).toHaveLength(1)
    expect(outbox.recorded).toEqual([[['child'], 'queued']])
    expect(retries).toEqual([])
  })

  test('retries are bounded, and a permanent failure is not retried', async () => {
    const retries: Array<() => void> = []
    const outbox = delivery((_delayMs, retry) => { retries.push(retry) })
    outbox.runtime.promptSession = async () => { throw locked() }
    outbox.parent.deliver('thread-A', report)
    await outbox.drain()
    for (let attempt = 0; attempt < DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
      retries.shift()!()
      await outbox.drain()
    }
    expect(retries).toEqual([])
    expect(outbox.recorded).toEqual([])

    const permanent = delivery((_delayMs, retry) => { retries.push(retry) })
    permanent.runtime.promptSession = async () => { throw new Error('Session thread-A not found') }
    permanent.parent.deliver('thread-A', report)
    await permanent.drain()
    expect(retries).toEqual([])
  })
})
