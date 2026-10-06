import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionRunInput } from '@solus/contracts/types'
import type { QueuedRequest } from '@solus/server/execution/sessions/session-request-queue'
import type { SavedQueueEntry } from '@solus/server/data/sessions/run-ledger'
import { SessionPermissionStore } from '@solus/server/data/sessions/session-permission-store'
import { childPermissionMode } from '@solus/server/execution/sessions/child-permissions'
import { HandoffCarryStore } from '@solus/server/data/sessions/handoff-carry-store'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let SessionRequestQueue: typeof import('@solus/server/execution/sessions/session-request-queue')['SessionRequestQueue']
let RunLedger: typeof import('@solus/server/data/sessions/run-ledger')['RunLedger']
let db: typeof import('@solus/server/db')
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-queue-db-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ SessionRequestQueue } = await import('@solus/server/execution/sessions/session-request-queue'))
  ;({ RunLedger } = await import('@solus/server/data/sessions/run-ledger'))
  db = await import('@solus/server/db')
})
afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  db.getDb().exec('DELETE FROM run_queue')
})
function storage() {
  const root = mkdtempSync(join(tmpdir(), 'solus-queue-'))
  roots.push(root)
  return { root, store: new RunLedger() }
}
const input: SessionRunInput = {
  provider: 'claude-code', agentSessionId: 'native-1', workingDirectory: '/tmp/project', projectPath: '/tmp/project',
  model: 'claude-sonnet-5', preferredModel: 'claude-sonnet-5', permissionMode: 'supervised', reasoningEffort: 'medium',
  contextWindow: 200_000, fastMode: false, extraInstructions: '', forked: false, additionalDirs: [], sessionChangedFiles: [],
  rateLimitBehavior: 'ask', worktreeBaseBranch: null,
}
function entry(queueId: string, overrides: Partial<QueuedRequest> = {}): QueuedRequest {
  return { queueId, sessionId: 'session', prompt: queueId, enqueuedAt: 1, reason: 'busy', resolve() {}, reject() {},
    requestedInput: { ...input }, run: { sessionId: 'session', target: { kind: 'session', sessionId: 'session' }, input: { ...input }, tools: [],
      options: { prompt: queueId, clientPromptId: queueId } }, ...overrides }
}

test('restart preserves order, attachments and uncertain receipts, and holds all work', () => {
  const { store } = storage()
  const queue = new SessionRequestQueue(store)
  const first = entry('first')
  first.run.options.queueAttachments = [{ id: 'file', name: 'notes.md', type: 'file', hostPath: '/tmp/notes.md' }]
  queue.enqueue(first)
  queue.enqueue(entry('second'))
  expect(queue.claim('session')?.queueId).toBe('first')
  const restored = new SessionRequestQueue(store)
  expect(restored.get('session')?.map((item) => item.queueId)).toEqual(['first', 'second'])
  expect(restored.get('session')?.every((item) => item.held)).toBe(true)
  expect(restored.get('session')?.[0]?.error).toContain('after this entry started')
  expect(restored.get('session')?.[0]?.run.options.queueAttachments?.[0]?.name).toBe('notes.md')
  expect(restored.claim('session')).toBeUndefined()
  expect(restored.hasPrompt('session', 'first')).toBe(true)
  const saved = db.getDb().prepare('SELECT payload FROM run_queue').all().map((row) => JSON.stringify(row)).join('\n')
  expect(saved).toContain('notes.md')
  expect(saved).not.toContain('"tools"')
  expect(saved).not.toContain('"actor"')
  expect(saved).not.toContain('"resolve"')
})

test('settlement removes a receipt; a failed switch blocks following work', () => {
  const { store } = storage()
  const queue = new SessionRequestQueue(store)
  const first = entry('first')
  queue.enqueue(first)
  queue.claim('session')
  queue.settle(first)
  expect(new SessionRequestQueue(store).size).toBe(0)
  const change = entry('switch', { kind: 'provider_switch' })
  queue.enqueue(change)
  queue.enqueue(entry('later'))
  queue.claim('session')
  queue.settle(change, 'Required history cannot fit')
  expect(queue.get('session')?.map((item) => item.queueId)).toEqual(['switch', 'later'])
  expect(queue.claim('session')).toBeUndefined()
})

test('moving and removing switches changes subsequent prompt providers', () => {
  const queue = new SessionRequestQueue()
  const change = entry('switch', { kind: 'provider_switch' })
  change.run.input = { ...input, provider: 'codex', model: 'gpt-6-astra', preferredModel: 'gpt-6-astra' }
  queue.enqueue(change)
  queue.enqueue(entry('prompt'))
  queue.rebind('session', input)
  expect(queue.get('session')?.[1]?.run.input.provider).toBe('codex')
  queue.move('session', 'prompt', 'switch')
  queue.rebind('session', input)
  expect(queue.get('session')?.[0]?.run.input.provider).toBe('claude-code')
  queue.move('session', 'prompt', null)
  queue.rebind('session', input)
  queue.remove('session', 'switch')
  queue.rebind('session', input)
  expect(queue.get('session')?.[0]?.run.input.model).toBe('claude-sonnet-5')
})

test('a failed disk write cannot consume or silently change an accepted prompt', () => {
  class FailingStore extends RunLedger {
    fail = false
    override saveQueue(sessionId: string, entries: readonly SavedQueueEntry[]): void {
      if (this.fail) throw new Error('Disk full')
      super.saveQueue(sessionId, entries)
    }
  }
  const store = new FailingStore()
  const queue = new SessionRequestQueue(store)
  const pending = entry('first')
  queue.enqueue(pending)
  store.fail = true
  expect(() => queue.claim('session')).toThrow('Disk full')
  expect(() => queue.remove('session', 'first')).toThrow('Disk full')
  expect(() => queue.edit(pending, { kind: 'edit', queueId: 'first', revision: 0, text: 'Changed' })).toThrow('Disk full')
  expect(queue.get('session')?.[0]?.run.options.prompt).toBe('first')
  expect(queue.get('session')?.[0]?.revision).toBe(0)
  expect(() => queue.rebind('session', { ...input, provider: 'codex', model: 'gpt-6-astra' })).toThrow('Disk full')
  expect(pending.run.input.provider).toBe('claude-code')
  expect(pending.revision).toBe(0)
  store.fail = false
  queue.claim('session')
  store.fail = true
  expect(() => queue.settle(pending)).toThrow('Disk full')
  expect(queue.hasPrompt('session', 'first')).toBe(true)
  expect(() => queue.settle(pending, 'Delivery failed')).toThrow('Disk full')
  expect(queue.get('session')).toBeUndefined()
  expect(pending.held).toBeUndefined()
  expect(queue.hasPrompt('session', 'first')).toBe(true)
  queue.holdUncertain(pending, 'Check history before resuming')
  expect(queue.get('session')?.[0]?.held).toBe(true)
  expect(queue.claim('session')).toBeUndefined()
  expect(new SessionRequestQueue(store).get('session')?.[0]?.error).toContain('after this entry started')
  store.fail = false
  queue.remove('session', 'first')
  expect(new SessionRequestQueue(store).size).toBe(0)
})

test('child policies can inherit or restrict access, never enlarge it', () => {
  expect(childPermissionMode('supervised')).toBe('supervised')
  expect(childPermissionMode('full-access', 'accept-edits')).toBe('accept-edits')
  expect(childPermissionMode('auto', 'supervised')).toBe('supervised')
  expect(childPermissionMode('accept-edits', 'plan')).toBe('plan')
  expect(() => childPermissionMode('plan', 'supervised')).toThrow('cannot change permissions')
  expect(() => childPermissionMode('supervised', 'full-access')).toThrow('cannot change permissions')
  expect(() => childPermissionMode('auto', 'accept-edits')).toThrow('cannot change permissions')
})

test('permission limits survive process release and host restart', () => {
  const { root } = storage()
  const file = join(root, 'permissions.json')
  new SessionPermissionStore(file).set('child', 'plan')
  expect(new SessionPermissionStore(file).get('child')).toBe('plan')
})

test('interrupted public work survives restart without reasoning, tools, or child output', () => {
  const { root } = storage()
  const carry = new HandoffCarryStore(join(root, 'carry'))
  carry.settle('thread', 'interrupted', [
    { type: 'user_message', text: 'Fix the parser' },
    { type: 'text_chunk', text: 'The first ' }, { type: 'text_chunk', text: 'file is changed.' },
    { type: 'thinking', state: 'stop', text: 'Private reasoning' },
    { type: 'text_chunk', text: 'Child output', parentToolUseId: 'child' },
  ], 100)
  const restored = new HandoffCarryStore(join(root, 'carry'))
  expect(restored.get('thread')?.status).toBe('interrupted')
  expect(restored.merge('thread', [{ role: 'user', content: 'Fix the parser', timestamp: 1 }])).toEqual([
    { role: 'user', content: 'Fix the parser', timestamp: 1 }, { role: 'assistant', content: 'The first file is changed.', timestamp: 100 },
  ])
  restored.settle('thread', 'completed', [], 101)
  expect(new HandoffCarryStore(join(root, 'carry')).get('thread')).toBeUndefined()
})


test('merged reports restore their complete dependency set with the same prompt', () => {
  const { store } = storage()
  const queue = new SessionRequestQueue(store)
  const report = entry('reports')
  queue.enqueue(report)
  queue.edit(report, { kind: 'edit', queueId: 'reports', revision: 0, text: 'Both child results' },
    { reportExchangeIds: ['child-one', 'child-two'], exchangeIds: ['parent-request'] })
  const restored = new SessionRequestQueue(store).get('session')![0]!
  expect(restored.run).toMatchObject({ reportExchangeIds: ['child-one', 'child-two'], exchangeIds: ['parent-request'] })
  expect(restored.run.options.prompt).toBe('Both child results')
  expect(restored.held).toBe(true)
})
