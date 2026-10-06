import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { AutomationAction } from '@solus/contracts/types'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/015-notifications-hub.md v2 §3–4, stage 2: an automation result is written
// to the hub's one table in the run's own SQLite transaction: a failed run write
// leaves no row, and a finished run's row survives a restart. A file that ran v1
// is migrated to the same single table, keeping its rows.

let store: typeof import('@solus/server/data/notifications/store')
let automations: typeof import('@solus/server/data/automations/automations-store')
let legacy: typeof import('@solus/server/db')
let database: typeof import('@solus/server/db/database')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-notification-automation-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/notifications/store')
  automations = await import('@solus/server/data/automations/automations-store')
  legacy = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

beforeEach(async () => {
  await database.getDatabase().run(sql`DELETE FROM notifications`)
})

const action: AutomationAction = { prompt: 'Check CI.', agentProvider: 'codex', modelId: null, reasoningEffort: 'medium', cwd: '/repo' }
const dana = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'dana' }, displayName: 'Dana' } }
const inbox = async (recipientKey: string) => (await store.listNotifications({ scope: 'local', recipientKey }, {})).items

// Automation runs live in the host's SQLite file; the hub row is written there atomically or not at all.
describe.skipIf(Boolean(process.env.DATABASE_URL))('automation results', () => {
  test('the row is written with the run and is announced after the commit', async () => {
    const automation = await automations.createAutomation('Nightly', action, dana)
    const run = await automations.startRun(automation.id)
    const heard: string[] = []
    const stop = store.onNotificationsChanged((change) => heard.push(change.recipientKey))
    await automations.finishRun(automation.id, run.id, { status: 'succeeded' })
    stop()
    expect((await inbox('dana')).map((row) => row.eventId)).toEqual([`automation.finished:${run.id}`])
    expect(heard).toEqual(['dana'])
  })

  test('the row names the conversation the run started, so the hub can open it', async () => {
    const automation = await automations.createAutomation('Nightly', action, dana)
    const run = await automations.startRun(automation.id)
    await automations.finishRun(automation.id, run.id, { status: 'succeeded', agentSessionId: 'agent-session-1' })
    expect((await inbox('dana'))[0]?.resource).toEqual({ kind: 'automation', automationId: automation.id, runId: run.id, sessionId: 'agent-session-1' })
  })

  test('a run write that fails leaves no notification', () => {
    expect(() => legacy.withTx(() => {
      store.recordNotificationSync(legacy.getDb(), {
        organizationId: 'local', eventId: 'automation.finished:failed-run', recipients: ['dana'],
        facts: { kind: 'automation.finished', status: 'failed' }, resource: { kind: 'automation', automationId: 'a', runId: 'failed-run' },
        by: { kind: 'automation', automationId: 'a' }, summary: { title: 'Nightly' },
      })
      throw new Error('the run write failed')
    })).toThrow('the run write failed')
    return expect(inbox('dana')).resolves.toEqual([])
  })

  test('a finished run\'s notification survives a restart', async () => {
    const automation = await automations.createAutomation('Weekly', action, dana)
    const run = await automations.startRun(automation.id)
    await automations.finishRun(automation.id, run.id, { status: 'cancelled' })
    await database.closeDatabase()
    legacy.closeDb()
    expect((await inbox('dana')).map((row) => row.facts)).toEqual([{ kind: 'automation.finished', status: 'cancelled' }])
  })
})

describe('the v1 to v2 upgrade', () => {
  test('a file in v1\'s shape converges to one table, and its rows survive', async () => {
    const { readMigrationFiles } = await import('drizzle-orm/migrator')
    const { migrationsFolder } = await import('@solus/server/db/migration-files')
    const { runSqliteSchemaMigrations } = await import('@solus/server/db/sqlite-migrations')
    const { migrations, runMigrations } = await import('@solus/server/db/migrations')
    const file = new Database(':memory:')
    // SAFETY: bun:sqlite answers the calls the migration runners make on a node:sqlite handle.
    const db = file as unknown as import('node:sqlite').DatabaseSync

    // The host-local slots, then v1's intent table as v1's slot left it.
    // Later host-local slots are not v1's, so the file stops before the slot that drops its table.
    const v2Slot = migrations.findIndex((sql) => sql.includes('DROP TABLE IF EXISTS notification_intents'))
    for (const sql of migrations.slice(0, v2Slot)) file.exec(sql)
    file.exec('CREATE TABLE notification_intents (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)')
    file.exec(`PRAGMA user_version = ${v2Slot}`)

    // The generated migrations through v1's 0003, recorded as the runner records them.
    file.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)')
    for (const migration of readMigrationFiles({ migrationsFolder: migrationsFolder('sqlite') }).slice(0, 4)) {
      for (const statement of migration.sql) file.exec(statement)
      file.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis)
    }
    file.exec(`INSERT INTO notifications (id, organization_id, recipient_key, event_id, kind, resource_key, facts, resource, by, summary, created_at, read_at, revision, position)
      VALUES ('n1', 'local', 'dana', 'e1', 'task.assigned', 'task:t', '{}', '{}', '{}', '{}', 1, 5, 3, 9)`)

    runMigrations(db)
    runSqliteSchemaMigrations(db)

    const tables = (file.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'notification%' ORDER BY name").all() as { name: string }[]).map((row) => row.name)
    expect(tables).toEqual(['notification_pr_observations', 'notifications'])
    const columns = (file.prepare('PRAGMA table_info(notifications)').all() as { name: string }[]).map((row) => row.name)
    expect(columns).toEqual(['id', 'organization_id', 'recipient_key', 'event_id', 'activity_id', 'kind', 'resource_key', 'facts', 'resource', 'by', 'summary', 'created_at', 'read_at', 'archived_at'])
    expect(file.prepare('SELECT id, recipient_key, read_at FROM notifications').all()).toEqual([{ id: 'n1', recipient_key: 'dana', read_at: 5 }])
    file.close()
  })
})
