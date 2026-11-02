import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { StatementLog } from './helpers/statement-log'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * plans/028 C1 and C2, plans/029 §4.1 and §8: on a host whose owner reads every
 * organization, the session pages and the `parent_session_id` reads are
 * served by the `session_any_page`, `session_by_activity` and
 * `session_by_parent` indexes. A page is an index walk that stops at its
 * limit: no scan of the table, and no temporary b-tree to sort it.
 */

const SESSIONS = 2_000
let dataDir: string
let log: StatementLog
let getDb: typeof import('@solus/server/db').getDb
let closeDb: () => void
let closeDatabase: () => Promise<void>
let operations: InstanceType<typeof import('@solus/server/data/sessions/api-operations')['SessionApiOperations']>
const context = {
  principal: { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Mac' },
  home: { kind: 'local' as const, hostId: 'this-mac' },
  scopes: ['sessions:read' as const],
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-page-plans-'))
  process.env.SOLUS_DATA_DIR = dataDir
  const hostDb = await import('@solus/server/db')
  ;({ getDb, closeDb } = hostDb)
  const db = getDb()
  log = new StatementLog(db)
  const database = await import('@solus/server/db/database')
  closeDatabase = database.closeDatabase
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  operations = new SessionApiOperations(new ShareManager({ db: database.getDatabase() }))

  const record = db.prepare(`INSERT INTO session(session_id, organization_id, created_by, provider, project_path, cwd, status, title, parent_session_id, created_at, last_activity_at, started_at)
    VALUES (?, 'local', 'owner', 'codex', '-repo', '/repo', 'idle', ?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  for (let i = 0; i < SESSIONS; i++) {
    // Every twentieth session was started by the one before it.
    const parent = i % 20 === 1 ? `s-${String(i - 1).padStart(4, '0')}` : null
    record.run(`s-${String(i).padStart(4, '0')}`, `Session ${i}`, parent, 1_000 + i, 1_000 + ((i * 7) % SESSIONS), 1_000 + i)
  }
  db.exec('COMMIT')
  db.exec('ANALYZE')
})

afterAll(async () => {
  await closeDatabase()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

/** The plans of the request's ordered reads of the `session` table (the pages, not the per-id reads that follow), one string each. */
function sessionPlans(): string[] {
  const pages = log.of('SELECT', 'session').filter(({ text }) => /ORDER BY/.test(text))
  expect(pages.length).toBeGreaterThan(0)
  return pages.map(({ text }) =>
    (getDb().prepare(`EXPLAIN QUERY PLAN ${text}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(' | '))
}

function expectIndexed(plan: string, index: string): void {
  expect(plan).not.toMatch(/TEMP B-TREE/)
  expect(plan).not.toMatch(/SCAN "?session"?(?! USING)/)
  expect(plan).toMatch(new RegExp(`"?session"? USING (COVERING )?INDEX ${index}`))
}

test('the created-order page and its next page walk session_by_parent for the top-level sessions', async () => {
  log.clear()
  const first = await operations.list(context, { limit: 50, scope: 'all' })
  expect(first.items).toHaveLength(50)
  expect(first.items[0]!.id).toBe('s-1999')
  for (const plan of sessionPlans()) expectIndexed(plan, 'session_by_parent')

  log.clear()
  const second = await operations.list(context, { limit: 50, scope: 'all', cursor: first.nextCursor! })
  // The pages hold the top-level sessions in creation order, each once; a session started by another is not among them.
  const ids = [...first.items, ...second.items].map((item) => item.id)
  expect(ids).toHaveLength(100)
  expect([...ids].sort().reverse()).toEqual(ids)
  expect(ids.some((id) => Number(id.slice(2)) % 20 === 1)).toBe(false)
  for (const plan of sessionPlans()) expectIndexed(plan, 'session_by_parent')
})

test('the activity-order page walks an index in activity order and seeks its cursor', async () => {
  log.clear()
  const first = await operations.list(context, { limit: 50, scope: 'all', order: 'activity' })
  const activity = (item: { updatedAt: string }) => Date.parse(item.updatedAt)
  expect(first.items.every((item, index) => index === 0 || activity(first.items[index - 1]!) >= activity(item))).toBe(true)
  for (const plan of sessionPlans()) expectIndexed(plan, 'session_(by_activity|by_parent)')

  log.clear()
  const second = await operations.list(context, { limit: 50, scope: 'all', order: 'activity', cursor: first.nextCursor! })
  expect(activity(second.items[0]!)).toBeLessThanOrEqual(activity(first.items.at(-1)!))
  for (const plan of sessionPlans()) expectIndexed(plan, 'session_(by_activity|by_parent)')
})

test("one session's children and a lead's delegation tree seek session_by_parent", async () => {
  log.clear()
  const children = await operations.list(context, { limit: 50, scope: 'all', parentSessionId: 's-0000' })
  expect(children.items.map((item) => item.id)).toEqual(['s-0001'])
  for (const plan of sessionPlans()) expectIndexed(plan, 'session_by_parent')

  const { readSessionArtifacts } = await import('@solus/server/data/sessions/session-artifacts')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  log.clear()
  const artifacts = await readSessionArtifacts(ANY_ORGANIZATION, 's-0020')
  expect(artifacts.children.map((child) => child.sessionId)).toEqual(['s-0021'])
  for (const plan of sessionPlans()) expectIndexed(plan, 'session_by_parent')
})
