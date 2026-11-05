import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { AutomationAction } from '@solus/contracts/types'
import { resetTestDatabase } from './helpers/test-db'
import { notificationReader } from './helpers/actors'

mock.module('node:sqlite', () => ({ DatabaseSync }))

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
const inbox = async (recipientKey: string) => (await store.listNotifications(notificationReader(recipientKey, 'local'), {})).items

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
    await automations.finishRun(automation.id, run.id, { status: 'succeeded', sessionId: 'agent-session-1' })
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
