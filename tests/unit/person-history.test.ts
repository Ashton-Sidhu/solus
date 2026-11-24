import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { PERSON_HISTORY_LIMIT } from '@solus/contracts/person-history'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A person's history in their home (docs/plans/person-state.md §4): one entry
 * for each record, the later time wins, and nobody reads another person's.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let dataDir: string
let db: typeof import('@solus/server/db')
let history: typeof import('@solus/server/data/personal-state/person-history')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-person-history-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  history = await import('@solus/server/data/personal-state/person-history')
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

const ALICE = 'user:alice'
const BOB = 'user:bob'
const LOCAL = 'local'

describe('a person’s history', () => {
  test('keeps the later open of each record, whatever order the batches arrive in', async () => {
    // WHY: clients batch and retry. A batch that left a phone before the
    // desktop's newer open must not move the record back in the row.
    await history.recordPersonHistory(LOCAL, ALICE, [{ key: 'work:w1', openedAt: 2_000 }, { key: 'app:h1:a1', openedAt: 1_000 }])
    await history.recordPersonHistory(LOCAL, ALICE, [{ key: 'work:w1', openedAt: 1_500 }, { key: 'app:h1:a1', openedAt: 3_000 }])
    expect(await history.readPersonHistory(LOCAL, ALICE)).toEqual([
      { key: 'app:h1:a1', openedAt: 3_000 },
      { key: 'work:w1', openedAt: 2_000 },
    ])
  })

  test('caps a time at server time, so a fast clock cannot hold the front of the row', async () => {
    const before = Date.now()
    await history.recordPersonHistory(LOCAL, ALICE, [{ key: 'work:future', openedAt: before + 86_400_000 }])
    const [entry] = await history.readPersonHistory(LOCAL, ALICE)
    expect(entry!.openedAt).toBeLessThanOrEqual(Date.now())
    expect(entry!.openedAt).toBeGreaterThanOrEqual(before)
  })

  test('is each person’s own, and each scope’s own', async () => {
    // WHY: a teammate on the same home must not see what Alice opened, and the
    // Solus API keeps each account's history in its own person scope.
    await history.recordPersonHistory(LOCAL, ALICE, [{ key: 'work:secret', openedAt: 1_000 }])
    await history.recordPersonHistory('person:alice', ALICE, [{ key: 'work:cloud', openedAt: 1_000 }])
    expect(await history.readPersonHistory(LOCAL, BOB)).toEqual([])
    expect((await history.readPersonHistory(LOCAL, ALICE)).map((entry) => entry.key)).toEqual(['work:secret'])
    expect((await history.readPersonHistory('person:alice', ALICE)).map((entry) => entry.key)).toEqual(['work:cloud'])
  })

  test('drops a key that names no history kind', async () => {
    await history.recordPersonHistory(LOCAL, ALICE, [{ key: 'pull-request:https://x', openedAt: 1_000 }])
    expect(await history.readPersonHistory(LOCAL, ALICE)).toEqual([])
  })

  test('keeps only the newest entries of a person', async () => {
    const entries = Array.from({ length: PERSON_HISTORY_LIMIT + 5 }, (_, index) => ({ key: `work:w${index}`, openedAt: index + 1 }))
    for (let start = 0; start < entries.length; start += 100) {
      await history.recordPersonHistory(LOCAL, ALICE, entries.slice(start, start + 100))
    }
    const kept = await history.readPersonHistory(LOCAL, ALICE)
    expect(kept).toHaveLength(PERSON_HISTORY_LIMIT)
    expect(kept.at(-1)!.key).toBe('work:w5')
  })

  test('an entry that leaves the history keeps the other state of its row', async () => {
    // WHY: history is one column of `personal_resource_state`, beside the state
    // a home acts on. Trimming the history must never drop a pin or a snooze.
    const { getDatabase } = await import('@solus/server/db/database')
    await history.recordPersonHistory(LOCAL, ALICE, [{ key: 'work:kept', openedAt: 1 }])
    await getDatabase().run(sql`UPDATE personal_resource_state SET pinned_at = 5 WHERE resource_id = 'kept'`)
    const newer = Array.from({ length: PERSON_HISTORY_LIMIT }, (_, index) => ({ key: `work:n${index}`, openedAt: index + 10 }))
    for (let start = 0; start < newer.length; start += 100) await history.recordPersonHistory(LOCAL, ALICE, newer.slice(start, start + 100))
    expect((await history.readPersonHistory(LOCAL, ALICE)).some((entry) => entry.key === 'work:kept')).toBe(false)
    const row = await getDatabase().get<{ pinned_at: number; opened_at: number | null }>(sql`SELECT pinned_at, opened_at FROM personal_resource_state WHERE resource_id = 'kept'`)
    expect(row).toEqual({ pinned_at: 5, opened_at: null })
  })

  test('tells the person’s connections the times it now holds', async () => {
    const heard: { personKey: string; keys: string[] }[] = []
    const stop = history.onPersonHistoryChanged((change) => heard.push({ personKey: change.personKey, keys: change.entries.map((entry) => entry.key) }))
    await history.recordPersonHistory(LOCAL, ALICE, [{ key: 'work:w1', openedAt: 1_000 }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop()
    expect(heard).toEqual([{ personKey: ALICE, keys: ['work:w1'] }])
  })
})
