import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * One session id (docs/plans/session-identity.md): a session that changes
 * provider keeps its id, its record and the facts that are the session's. One
 * session row (plans/029-fresh-database-baseline.md §4.2): the row is the
 * birth, and its owner and organization never change after the first insert.
 */

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
let indexer: typeof import('@solus/server/db/session-indexer')
let lineage: typeof import('@solus/server/data/sessions/session-lineage')
let records: typeof import('@solus/server/data/sessions/session-records')
let identity: typeof import('@solus/server/data/sessions/session-identity')
let states: typeof import('@solus/server/data/sessions/session-states')
let leads: typeof import('@solus/server/data/sessions/lead-sessions')
let database: typeof import('@solus/server/db/database')
let closeDb: typeof import('@solus/server/db')['closeDb']
let getDb: typeof import('@solus/server/db')['getDb']

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-identity-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb, getDb } = await import('@solus/server/db'))
  closeDb()
  indexer = await import('@solus/server/db/session-indexer')
  lineage = await import('@solus/server/data/sessions/session-lineage')
  records = await import('@solus/server/data/sessions/session-records')
  identity = await import('@solus/server/data/sessions/session-identity')
  states = await import('@solus/server/data/sessions/session-states')
  leads = await import('@solus/server/data/sessions/lead-sessions')
  database = await import('@solus/server/db/database')
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200 && !await condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await condition()).toBe(true)
}

describe('a session that switches provider', () => {
  test('is one record under its session id, and its name follows it to the new thread', async () => {
    lineage.registerSessionLineage({ sessionId: 'session-a', provider: 'claude-code', providerSessionId: 'thread-claude', cwd: '/repo' })
    indexer.persistIndexedSessionStart('thread-claude', 'claude-code', '/repo', '-repo', 'opus', 'high', 'fix the parser')
    await until(async () => !!await records.getSessionRecord('local', 'session-a'))
    await indexer.setSessionCustomTitle('session-a', 'Parser fix')

    lineage.beginSessionHandoff({ sessionId: 'session-a', sourceProvider: 'claude-code', sourceProviderSessionId: 'thread-claude', targetProvider: 'codex', cwd: '/repo' })
    lineage.completeSessionHandoff('session-a', 'codex', 'thread-codex', '/repo')
    indexer.persistIndexedSessionStart('thread-codex', 'codex', '/repo', '-repo', 'gpt-test', 'medium', 'continue')

    await until(() => indexer.getIndexedSession('session-a')?.customTitle === 'Parser fix')
    const record = await records.getSessionRecord('local', 'session-a')
    expect(record).toMatchObject({ sessionId: 'session-a', provider: 'codex', customTitle: 'Parser fix' })
    // Neither thread has a record of its own.
    expect(await records.getSessionRecord('local', 'thread-claude')).toBeNull()
    expect(await records.getSessionRecord('local', 'thread-codex')).toBeNull()
  })
})

describe('a run that names no model', () => {
  test('records no model, and keeps the model an earlier run recorded', async () => {
    lineage.registerSessionLineage({ sessionId: 'session-b', provider: 'claude-code', providerSessionId: 'thread-b', cwd: '/repo' })
    indexer.persistIndexedSessionStart('thread-b', 'claude-code', '/repo', '-repo', '', 'high', 'first')
    await until(async () => !!await records.getSessionRecord('local', 'session-b'))
    expect((await records.getSessionRecord('local', 'session-b'))?.model).toBeNull()

    indexer.persistIndexedSessionStart('thread-b', 'claude-code', '/repo', '-repo', 'opus', 'high', 'second')
    await until(async () => (await records.getSessionRecord('local', 'session-b'))?.model === 'opus')
    indexer.persistIndexedSessionStart('thread-b', 'claude-code', '/repo', '-repo', '', 'low', 'third')
    await until(async () => (await records.getSessionRecord('local', 'session-b'))?.reasoningEffort === 'low')
    expect((await records.getSessionRecord('local', 'session-b'))?.model).toBe('opus')
    expect(indexer.getIndexedSession('session-b')?.model).toBe('opus')
  })
})

describe('one session row (plans/029 §4.2)', () => {
  const ALICE = 'user:alice'
  const MALLORY = 'user:mallory'
  const facts = (sessionId: string, lastActivityAt = 10) => ({ sessionId, provider: 'codex' as const, projectPath: '-repo', lastActivityAt })

  test('the owner and the organization never change after the first insert, whichever writer made it', async () => {
    // WHY: a session belongs to the person who started it, where they started it
    // (docs/plans/access-model.md §2.2). A report, a repeat claim, or a later
    // birth must not re-own or move it.
    expect(await identity.claimSessionOwner('owned', { ownerKey: ALICE, organizationId: 'A' })).toBe(true)
    expect(await identity.claimSessionOwner('owned', { ownerKey: MALLORY, organizationId: 'B' })).toBe(false)
    await records.upsertSessionRecord('A', facts('owned'), { organizationId: 'A', published: true, ownerKey: MALLORY })
    await records.upsertOwnSessionRecord({ ...facts('owned', 11), title: 'Renamed' })
    expect(await records.getSessionRecord('A', 'owned')).toMatchObject({ ownerKey: ALICE, organizationId: 'A', publication: 'local', title: 'Renamed' })
    // A row in an organization is never assigned to another one; only a Local row takes an organization, once.
    expect(await records.assignSessionOrganization('owned', 'B')).toBeNull()
    expect((await identity.sessionIdentityOf('owned'))?.organizationId).toBe('A')
    await identity.claimSessionOwner('unassigned', { ownerKey: ALICE, organizationId: 'local' })
    expect((await records.assignSessionOrganization('unassigned', 'A'))?.organizationId).toBe('A')
    expect(await records.assignSessionOrganization('unassigned', 'B')).toBeNull()
    expect(await identity.sessionIdentityOf('unassigned')).toMatchObject({ ownerKey: ALICE, organizationId: 'A' })
  })

  test('an admission is idempotent for its person and host, refused for another, and fills a report that came first once', async () => {
    const admission = { organizationId: 'A', admissionId: 'admitted', hostId: 'vm-1', ownerKey: ALICE }
    const first = await identity.admitSession(admission)
    expect(first).toMatchObject({ ...admission, createdAt: expect.any(Number) })
    // A same-owner retry is a no-op that answers the same admission.
    expect(await identity.admitSession(admission)).toEqual(first)
    await expect(identity.admitSession({ ...admission, ownerKey: MALLORY })).rejects.toThrow(identity.SessionAdmissionConflict)
    await expect(identity.admitSession({ ...admission, hostId: 'vm-2' })).rejects.toThrow(identity.SessionAdmissionConflict)
    expect(await identity.readSessionAdmission('A', 'admitted')).toEqual(first)
    expect(await identity.sessionIdentityOf('admitted')).toMatchObject({ ownerKey: ALICE, organizationId: 'A', publication: 'published', startedAt: null })

    // A report that raced the admission made the row, owned by the person delivering; the admission fills its facts once.
    await records.upsertSessionRecord('A', facts('reported-first'), { organizationId: 'A', published: true, ownerKey: ALICE })
    expect(await identity.readSessionAdmission('A', 'reported-first')).toBeNull()
    const late = await identity.admitSession({ ...admission, admissionId: 'reported-first' })
    expect(await identity.readSessionAdmission('A', 'reported-first')).toEqual(late)
    await expect(identity.admitSession({ ...admission, admissionId: 'reported-first', ownerKey: MALLORY })).rejects.toThrow(identity.SessionAdmissionConflict)
    expect((await identity.sessionIdentityOf('reported-first'))?.ownerKey).toBe(ALICE)
  })

  test('started_at is set once by the first report; before it the provider facts are null and list reads do not show the row', async () => {
    await identity.claimSessionOwner('unstarted', { ownerKey: ALICE, organizationId: 'local' })
    const before = await database.getDatabase().get<{ started_at: number | null; provider: string | null; project_path: string | null }>(sql`
      SELECT started_at, provider, project_path FROM session_records WHERE session_id = 'unstarted'
    `)
    expect(before).toEqual({ started_at: null, provider: null, project_path: null })
    expect(await records.getSessionRecord('local', 'unstarted')).toBeNull()
    expect((await records.readSessionMetadataPage(sql`session_records.session_id = 'unstarted'`, 10)).map((record) => record.sessionId)).toEqual([])
    expect(await records.ownPublishedSessionIds()).not.toContain('unstarted')

    await records.upsertOwnSessionRecord(facts('unstarted', 20))
    const startedAt = (await identity.sessionIdentityOf('unstarted'))?.startedAt
    expect(startedAt).toEqual(expect.any(Number))
    await new Promise((resolve) => setTimeout(resolve, 2))
    await records.upsertOwnSessionRecord(facts('unstarted', 30))
    expect((await identity.sessionIdentityOf('unstarted'))?.startedAt).toBe(startedAt!)
    expect((await records.readSessionMetadataPage(sql`session_records.session_id = 'unstarted'`, 10)).map((record) => record.sessionId)).toEqual(['unstarted'])
  })

  test('the lead mark keeps its first value under repeated marks and every state writer', async () => {
    await leads.markSessionLead('lead')
    const first = await database.getDatabase().get<{ lead_started_at: number }>(sql`SELECT lead_started_at FROM session_records WHERE session_id = 'lead'`)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await leads.markSessionLead('lead', 'A')
    await new states.SessionShelf('lead').recordPrompt(ALICE)
    await new states.SessionShelf('lead').settle('task')
    await new states.SessionShelf('lead').unsettle()
    await records.upsertOwnSessionRecord(facts('lead'))
    expect(await database.getDatabase().get(sql`SELECT lead_started_at, organization_id FROM session_records WHERE session_id = 'lead'`)).toEqual({ lead_started_at: first!.lead_started_at, organization_id: 'local' })
    expect((await records.getSessionRecord('local', 'lead'))?.isLead).toBe(true)
  })

  test('a settle writes its time and its cause together, returns null when settled already, and a prompt on a never-started row is one UPDATE that clears it', async () => {
    const shelf = new states.SessionShelf('settled')
    expect(await shelf.settle('task', 100)).toEqual({ settledAt: 100, settledBy: 'task' })
    expect(await shelf.settle('pull-request', 200)).toBeNull()
    // The CHECK `(settled_at IS NULL) = (settled_by IS NULL)`, kept by the write commands.
    const settledPairs = await database.getDatabase().all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM session_records WHERE (settled_at IS NULL) <> (settled_by IS NULL)`)
    expect(Number(settledPairs[0]?.n)).toBe(0)
    expect((await identity.sessionIdentityOf('settled'))?.startedAt).toBeNull()
    const statements: string[] = []
    const connection = getDb() as unknown as { prepare: (text: string) => unknown }
    const prepare = connection.prepare.bind(connection)
    connection.prepare = (text: string) => { statements.push(text.trim().split(/\s+/).slice(0, 2).join(' ')); return prepare(text) }
    try {
      await shelf.recordPrompt(null, 300)
    } finally {
      connection.prepare = prepare
    }
    expect(statements.filter((statement) => !statement.startsWith('SELECT'))).toEqual(['UPDATE "session_records"'])
    expect(await shelf.state()).toEqual({ settledAt: null, settledBy: null })
    expect(Number((await database.getDatabase().all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM session_records WHERE (settled_at IS NULL) <> (settled_by IS NULL)`))[0]?.n)).toBe(0)
  })

  test('deleting the session removes its state, its lead and admission facts, its children, and its personal state', async () => {
    const db = database.getDatabase()
    await identity.admitSession({ organizationId: 'A', admissionId: 'gone', hostId: 'vm-1', ownerKey: ALICE })
    await records.upsertSessionRecord('A', facts('gone'))
    await leads.markSessionLead('gone', 'A')
    await new states.SessionShelf('gone').settle('task')
    await new states.SessionViewer('gone', ALICE).archive()
    await states.markSessionViewed('gone', ALICE, 5)
    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
    await sessionPrs.linkSessionPullRequest('gone', { url: 'https://github.com/acme/solus/pull/7', source: 'manual', by: { kind: 'system' } })
    getDb().prepare(`INSERT INTO runs (session_id, run_id, state, payload, updated_at) VALUES ('gone', 'run-1', 'running', '{}', 1)`).run()
    getDb().prepare(`INSERT INTO async_questions (question_id, session_id, agent_session_id, questions_json, state, created_at) VALUES ('q-1', 'gone', 'thread-gone', '[]', 'pending', 1)`).run()

    await records.deleteSessionRecord('A', 'gone')

    expect(await identity.sessionIdentityOf('gone')).toBeNull()
    expect(await identity.readSessionAdmission('A', 'gone')).toBeNull()
    expect(await leads.isLeadSession('gone')).toBe(false)
    expect(await new states.SessionShelf('gone').state()).toEqual({ settledAt: null, settledBy: null })
    expect(await db.all(sql`SELECT * FROM personal_resource_state WHERE resource_kind = 'session' AND resource_id = 'gone'`)).toEqual([])
    expect(await db.all(sql`SELECT * FROM resource_links WHERE source_id = 'gone' OR target_key = 'gone'`)).toEqual([])
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM runs WHERE session_id = 'gone'`).get()).toEqual({ n: 0 })
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM async_questions WHERE session_id = 'gone'`).get()).toEqual({ n: 0 })
    // A delete in another organization's scope removes nothing.
    await identity.claimSessionOwner('kept', { ownerKey: ALICE, organizationId: 'A' })
    await records.deleteSessionRecord('B', 'kept')
    expect(await identity.sessionIdentityOf('kept')).not.toBeNull()
  })
})
