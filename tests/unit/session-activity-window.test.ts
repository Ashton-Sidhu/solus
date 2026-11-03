import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { StatementLog } from './helpers/statement-log'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * plans/029 §8 (a carry-over of the first review): a history window or page
 * reads the activity inside it, not the session's whole record. The handlers
 * know the window before they ask: the first message of a cut window, and
 * where the newer page began.
 */

let dataDir: string
let log: StatementLog
let activity: typeof import('@solus/server/data/activity/activity')
let closeDb: () => void
let closeDatabase: () => Promise<void>

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-activity-window-'))
  process.env.SOLUS_DATA_DIR = dataDir
  const hostDb = await import('@solus/server/db')
  closeDb = hostDb.closeDb
  log = new StatementLog(hostDb.getDb())
  ;({ closeDatabase } = await import('@solus/server/db/database'))
  activity = await import('@solus/server/data/activity/activity')
})

afterAll(async () => {
  await closeDatabase()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a session read with a window gets the rows inside it, oldest first, from one range read', async () => {
  const { appendActivity, activityFor, newActivity } = activity
  const session = { kind: 'session' as const, id: 's1' }
  for (const at of [10, 20, 30, 40]) await appendActivity('local', newActivity(session, { kind: 'system' }, { kind: 'stopped' }, at))

  log.clear()
  const window = await activityFor('local', session, { window: { from: 20, until: 40 } })
  expect(window.map((entry) => entry.at)).toEqual([20, 30])
  expect(log.of('SELECT', 'activity')).toHaveLength(1)
  expect(log.of('SELECT', 'activity')[0]!.text).toMatch(/at >= \? AND at < \?/)

  // An open end reads to the edge; no window reads everything.
  expect((await activityFor('local', session, { window: { from: 30 } })).map((entry) => entry.at)).toEqual([30, 40])
  expect((await activityFor('local', session, { window: { until: 20 } })).map((entry) => entry.at)).toEqual([10])
  expect((await activityFor('local', session)).map((entry) => entry.at)).toEqual([10, 20, 30, 40])
  // The infinite ends a merge computes are no bound.
  expect((await activityFor('local', session, { window: { from: -Infinity, until: Infinity } })).map((entry) => entry.at)).toEqual([10, 20, 30, 40])
})
