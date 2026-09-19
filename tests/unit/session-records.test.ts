import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { encodePathAsFolder, SOLUS_WORKTREE_ENCODED_MARKER } from '@solus/contracts/types'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md: the collaboration plane's record of a
// session is what every client lists by; a runner reports it, the picker reads
// it, and it never leaves the organization it was written for.

type RecordsModule = typeof import('@solus/server/sessions/session-records')
type IndexerModule = typeof import('@solus/server/db/session-indexer')
type DbModule = typeof import('@solus/server/db')

let dataDir: string
let records: RecordsModule
let indexer: IndexerModule
let db: DbModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-records-'))
  process.env.SOLUS_DATA_DIR = dataDir
  records = await import('@solus/server/sessions/session-records')
  indexer = await import('@solus/server/db/session-indexer')
  db = await import('@solus/server/db')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const PROJECT = '/Users/test/solus'
const ENCODED = encodePathAsFolder(PROJECT)

describe('session records', () => {
  test('a field left out of a report keeps the stored value; a field given as null clears it', async () => {
    // WHY: the indexer's sweep and the control plane's status report each know
    // part of a session. A report that erased what the other wrote would make
    // the picker flicker between two half-truths.
    await records.upsertSessionRecord('local', {
      sessionId: 's1', provider: 'claude-code', projectPath: ENCODED, title: 'First prompt', model: 'opus', lastActivityAt: 10, size: 5,
    })
    await records.upsertSessionRecord('local', { sessionId: 's1', provider: 'claude-code', projectPath: ENCODED, status: 'running', lastActivityAt: 20 })
    expect(await records.getSessionRecord('local', 's1')).toMatchObject({
      title: 'First prompt', model: 'opus', status: 'running', size: 5, createdAt: 10, lastActivityAt: 20,
    })
    await records.upsertSessionRecord('local', { sessionId: 's1', provider: 'claude-code', projectPath: ENCODED, model: null, lastActivityAt: 15 })
    const record = await records.getSessionRecord('local', 's1')
    expect(record?.model).toBeNull()
    // Activity never runs backwards.
    expect(record?.lastActivityAt).toBe(20)
  })

  test('a record belongs to one organization; another organization lists nothing and cannot overwrite it', async () => {
    await records.upsertSessionRecord('org-a', { sessionId: 'shared-id', provider: 'codex', projectPath: ENCODED, title: 'Ours', lastActivityAt: 1 })
    await records.upsertSessionRecord('org-b', { sessionId: 'shared-id', provider: 'codex', projectPath: ENCODED, title: 'Theirs', lastActivityAt: 2 })
    expect((await records.listSessionRecords('org-a')).map((record) => record.title)).toEqual(['Ours'])
    expect(await records.listSessionRecords('org-b')).toEqual([])
    expect(await records.getSessionRecord('org-b', 'shared-id')).toBeNull()
    expect(await records.listSessionRecords('local')).toEqual([])
  })

  test('the list keeps the picker\'s filters: provider, project, worktrees beneath it, and a limit', async () => {
    const worktree = `${ENCODED}${SOLUS_WORKTREE_ENCODED_MARKER}feature`
    await records.upsertSessionRecord('local', { sessionId: 'main-old', provider: 'codex', projectPath: ENCODED, lastActivityAt: 1 })
    await records.upsertSessionRecord('local', { sessionId: 'main-new', provider: 'codex', projectPath: ENCODED, lastActivityAt: 3 })
    await records.upsertSessionRecord('local', { sessionId: 'worktree', provider: 'codex', projectPath: worktree, lastActivityAt: 2 })
    await records.upsertSessionRecord('local', { sessionId: 'claude', provider: 'claude-code', projectPath: ENCODED, lastActivityAt: 4 })
    await records.upsertSessionRecord('local', { sessionId: 'elsewhere', provider: 'codex', projectPath: encodePathAsFolder('/Users/test/other'), lastActivityAt: 5 })

    const ids = (list: Awaited<ReturnType<typeof records.listSessionRecords>>) => list.map((record) => record.sessionId)
    expect(ids(await records.listSessionRecords('local', { provider: 'codex', projectPath: PROJECT, includeWorktrees: true })))
      .toEqual(['main-new', 'worktree', 'main-old'])
    expect(ids(await records.listSessionRecords('local', { provider: 'codex', projectPath: PROJECT })))
      .toEqual(['main-new', 'main-old'])
    expect(ids(await records.listSessionRecords('local', { provider: 'codex', projectPath: PROJECT, includeWorktrees: true, limit: 1 })))
      .toEqual(['main-new'])
    expect(ids(await records.listSessionRecords('local', { provider: 'claude-code', projectPaths: [ENCODED, worktree] }))).toEqual(['claude'])
    expect(ids(await records.listSessionRecords('local'))).toEqual(['elsewhere', 'claude', 'main-new', 'worktree', 'main-old'])
  })

  test('the picker reads records and fills in what the transcript index holds; a record alone still lists', async () => {
    // WHY: the record is what the collaboration plane knows; the working
    // directory, slug, and branch are the runner's. A session another runner
    // holds must still show up in the list with what the record carries.
    await records.upsertSessionRecord('local', {
      sessionId: 'indexed', provider: 'codex', projectPath: ENCODED, title: 'From the record', lastActivityAt: 2, size: 9,
    })
    await records.upsertSessionRecord('local', {
      sessionId: 'remote', provider: 'codex', projectPath: ENCODED, title: 'Ran elsewhere', model: 'gpt', runnerHostId: 'studio', lastActivityAt: 1,
    })
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, cwd, project_path, slug, first_message, last_timestamp, size, branch)
      VALUES (?, 'codex', ?, ?, 'indexed-slug', 'From the index', 2, 9, 'feature/x')
    `).run('indexed', PROJECT, ENCODED)

    const listed = await indexer.listIndexedCodexSessions(PROJECT)
    expect(listed.map((session) => session.sessionId)).toEqual(['indexed', 'remote'])
    expect(listed[0]).toMatchObject({ cwd: PROJECT, slug: 'indexed-slug', firstMessage: 'From the index', branch: 'feature/x' })
    expect(listed[1]).toMatchObject({ cwd: '', firstMessage: 'Ran elsewhere', model: 'gpt', serverId: 'studio', projectPath: ENCODED })
  })

  test('a session start reports the record running; a restart marks what this host left running as interrupted', async () => {
    indexer.persistIndexedSessionStart('live', 'claude-code', PROJECT, ENCODED, 'opus', 'high', 'Do the thing', 'main')
    // The start's record write is not awaited by the caller; give it its turn.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await records.getSessionRecord('local', 'live')).toMatchObject({ status: 'running', title: 'Do the thing', model: 'opus', reasoningEffort: 'high' })
    await records.upsertSessionRecord('local', { sessionId: 'theirs', provider: 'codex', projectPath: ENCODED, status: 'running', runnerHostId: 'studio', lastActivityAt: 1 })

    expect(await records.markOwnRunningSessionRecordsInterrupted('local')).toBe(1)
    expect((await records.getSessionRecord('local', 'live'))?.status).toBe('interrupted')
    // Another runner's record is that runner's to settle.
    expect((await records.getSessionRecord('local', 'theirs'))?.status).toBe('running')
    await records.setSessionRecordStatus('local', 'live', records.sessionRecordStatusOf('completed'))
    expect((await records.getSessionRecord('local', 'live'))?.status).toBe('idle')
  })

  test('a name set on the session lands on its record', async () => {
    await records.upsertSessionRecord('local', { sessionId: 'named', provider: 'claude-code', projectPath: ENCODED, lastActivityAt: 1 })
    db.getDb().prepare("INSERT INTO sessions(session_id, provider, project_path, last_timestamp) VALUES ('named', 'claude', ?, 1)").run(ENCODED)
    await indexer.setSessionCustomTitle('named', 'Renamed')
    expect((await records.getSessionRecord('local', 'named'))?.customTitle).toBe('Renamed')
    expect((await indexer.listIndexedSessions([ENCODED]))[0]?.customTitle).toBe('Renamed')
  })
})
