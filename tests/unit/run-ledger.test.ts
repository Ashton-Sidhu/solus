import { beforeAll, afterAll, afterEach, describe, expect, test, mock, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RestartRun, SavedQueueEntry } from '@solus/server/data/sessions/run-ledger'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const previousDataDir = process.env.SOLUS_DATA_DIR
let directory: string
let RunLedger: typeof import('@solus/server/data/sessions/run-ledger')['RunLedger']
let closeDb: typeof import('@solus/server/db')['closeDb']
let getDb: typeof import('@solus/server/db')['getDb']
let runMigrations: typeof import('@solus/server/db/migrations')['runMigrations']
let migrations: typeof import('@solus/server/db/migrations')['migrations']
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-run-ledger-'))
  process.env.SOLUS_DATA_DIR = directory
  ;({ RunLedger } = await import('@solus/server/data/sessions/run-ledger'))
  ;({ closeDb, getDb } = await import('@solus/server/db'))
  ;({ runMigrations, migrations } = await import('@solus/server/db/migrations'))
})
afterEach(() => closeDb())
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})
const input: RestartRun['input'] = { provider: 'codex', agentSessionId: 'thread', workingDirectory: '/tmp/project', projectPath: '/tmp/project', model: 'gpt-6-astra',
  preferredModel: 'gpt-6-astra', permissionMode: 'plan', reasoningEffort: 'high', contextWindow: 1_050_000,
  fastMode: true, extraInstructions: '', forked: false, additionalDirs: [], sessionChangedFiles: [], rateLimitBehavior: 'ask', worktreeBaseBranch: null }
function run(sessionId: string): RestartRun {
  return { sessionId, runId: 'original', state: 'running', author: null, authority: 'host', prompt: 'Fix the parser', backgroundTools: [], input }
}
const activeRuns = () => new RunLedger().activeRuns

describe('active runs (restart receipts)', () => {
  test('recovery preserves the native conversation and options across database reopen', () => {
    const saved = run('persist')
    activeRuns().save(saved)
    closeDb()
    expect(activeRuns().get('persist')).toEqual(saved)
  })

  test('a durable recovery claim prevents another automatic delivery', () => {
    const saved = run('claim')
    const store = activeRuns()
    store.save(saved)
    expect(store.claim(saved)).toBe(true)
    closeDb()
    expect(activeRuns().get('claim')?.state).toBe('delivering')
    expect(activeRuns().claim(saved)).toBe(false)
  })

  test('new work and explicit stop invalidate the old receipt without deleting a newer run', () => {
    const store = activeRuns()
    const saved = run('newer')
    store.save(saved)
    store.save({ ...saved, runId: 'new' })
    store.remove('newer', 'original')
    expect(store.get('newer')?.runId).toBe('new')
    store.remove('newer')
    expect(store.get('newer')).toBeUndefined()
    expect(store.claim(saved)).toBe(false)
  })

  test('live receipt reads, repeated saves and absent removals do not execute SQL', () => {
    const store = activeRuns()
    const saved = run('cached')
    store.save(saved)
    const prepare = spyOn(getDb(), 'prepare')
    try {
      expect(store.get('cached')).toEqual(saved)
      expect(store.list().some((item) => item.sessionId === 'cached')).toBe(true)
      store.save(saved)
      store.remove('missing')
      store.remove('cached', 'different-run')
      expect(prepare).not.toHaveBeenCalled()
      store.save({ ...saved, state: 'background' })
      expect(prepare).toHaveBeenCalledTimes(1)
      store.remove('cached')
      store.remove('cached')
      expect(prepare).toHaveBeenCalledTimes(2)
    } finally {
      prepare.mockRestore()
    }
  })

  test('mutating a returned receipt cannot suppress its durable update', () => {
    const store = activeRuns()
    store.save(run('isolated'))
    const saved = store.get('isolated')!
    saved.backgroundTools.push({ toolId: 'tool', name: 'Bash' })
    expect(store.get('isolated')?.backgroundTools).toEqual([])
    store.save(saved)
    closeDb()
    expect(activeRuns().get('isolated')?.backgroundTools).toEqual([{ toolId: 'tool', name: 'Bash' }])
  })
})

describe('first boot after the JSON receipts', () => {
  test('restart receipts move from the old table into the ledger, and the old table goes', () => {
    const file = new Database(':memory:')
    // SAFETY: bun:sqlite answers the calls the migration runner makes on a node:sqlite handle.
    const legacy = file as unknown as import('node:sqlite').DatabaseSync
    runMigrations(legacy)
    const ledgerSlot = migrations.findIndex((sql) => sql.includes('CREATE TABLE runs ('))
    file.exec('DROP TABLE runs; DROP TABLE run_queue; DROP TABLE run_exchanges')
    file.exec(`CREATE TABLE session_restart_runs (session_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL DEFAULT 'local',
      run_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
    file.prepare('INSERT INTO session_restart_runs(session_id, run_id, state, payload, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy', 'original', 'running', JSON.stringify(run('legacy')), 1)
    // Every migration after the ledger runs again; the one that drops sessions.viewed_at needs the column,
    // and the one that adds sessions.started_by needs it gone.
    file.exec('ALTER TABLE sessions ADD COLUMN viewed_at INTEGER')
    file.exec('ALTER TABLE sessions DROP COLUMN started_by')
    file.exec(`PRAGMA user_version = ${ledgerSlot}`)
    runMigrations(legacy)
    expect(file.prepare('SELECT session_id, run_id, state FROM runs').all()).toEqual([{ session_id: 'legacy', run_id: 'original', state: 'running' }])
    expect(file.prepare("SELECT name FROM sqlite_master WHERE name = 'session_restart_runs'").all()).toEqual([])
    file.close()
  })

  test('queue and exchange files are imported once, in order, and removed', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'solus-legacy-queue-'))
    try {
      const entry = (queueId: string): SavedQueueEntry => ({ queueId, sessionId: 'legacy-session', prompt: queueId, enqueuedAt: 1, reason: 'busy',
        revision: 0, kind: 'prompt', held: false, input, options: { prompt: queueId } })
      writeFileSync(join(legacy, 'session.json'), JSON.stringify({ version: 1, entries: [entry('first'), entry('second')] }))
      mkdirSync(join(legacy, 'exchanges'))
      writeFileSync(join(legacy, 'exchanges', 'exchange.json'), JSON.stringify({
        version: 1, exchangeId: 'legacy-exchange', kind: 'prompt', senderSessionId: 'A', senderAgentSessionId: 'thread-A',
        targetSessionId: 'B', targetAgentSessionId: 'thread-B', provider: 'codex', notify: true, state: 'settled',
        parentExchangeIds: [], dispatchedAt: Date.now(), settledAt: Date.now(), outcome: 'completed', outputsText: '',
        reportText: 'Done', deliveryState: 'pending',
      }))
      const ledger = new RunLedger(legacy)
      expect(ledger.loadQueue().filter((item) => item.sessionId === 'legacy-session').map((item) => item.queueId)).toEqual(['first', 'second'])
      expect(ledger.loadExchanges().find((item) => item.exchangeId === 'legacy-exchange')).toMatchObject({ deliveryState: 'pending', reportText: 'Done' })
      expect(existsSync(join(legacy, 'session.json'))).toBe(false)
      expect(existsSync(join(legacy, 'exchanges', 'exchange.json'))).toBe(false)
      // A second boot finds nothing more to import and keeps the rows.
      expect(new RunLedger(legacy).loadQueue().filter((item) => item.sessionId === 'legacy-session')).toHaveLength(2)
    } finally {
      rmSync(legacy, { recursive: true, force: true })
    }
  })
})
