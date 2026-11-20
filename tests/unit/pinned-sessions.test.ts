import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const ALICE = 'user:alice'
const BOB = 'user:bob'

let dataDir: string
let db: typeof import('@solus/server/db')
let pins: typeof import('@solus/server/data/sessions/pinned-sessions')
let records: typeof import('@solus/server/data/sessions/session-records')
let states: typeof import('@solus/server/data/sessions/session-states')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pinned-sessions-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  pins = await import('@solus/server/data/sessions/pinned-sessions')
  records = await import('@solus/server/data/sessions/session-records')
  states = await import('@solus/server/data/sessions/session-states')
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

async function recorded(sessionId: string, title = sessionId) {
  await records.upsertSessionRecord('local', {
    sessionId, provider: 'codex', projectPath: '-repo', cwd: '/repo', title, model: 'gpt-5.6-sol', lastActivityAt: 1,
  }, { organizationId: 'local', ownerKey: ALICE })
}

const pinnedIds = async (personKey: string) => (await pins.readPinnedSessions(personKey)).map((pin) => pin.sessionId)

describe('pinned sessions', () => {
  test('a pin shows what the session record says now', async () => {
    // WHY: a pin that copied its label kept the old name after a rename.
    await recorded('session-1', 'First name')
    expect(await pins.togglePinnedSession(ALICE, { sessionId: 'session-1', pinnedAt: 42 })).toEqual([
      { sessionId: 'session-1', provider: 'codex', model: 'gpt-5.6-sol', title: 'First name', cwd: '/repo', pinnedAt: 42 },
    ])
    await records.setSessionRecordGeneratedTitle('session-1', 'Second name')
    expect((await pins.readPinnedSessions(ALICE))[0]?.title).toBe('Second name')
  })

  test("pins are each person's own, and an undo returns a pin to its place", async () => {
    for (const sessionId of ['older', 'newer']) await recorded(sessionId)
    await pins.togglePinnedSession(ALICE, { sessionId: 'older', pinnedAt: 1 })
    await pins.togglePinnedSession(ALICE, { sessionId: 'newer', pinnedAt: 2 })
    expect(await pinnedIds(ALICE)).toEqual(['newer', 'older'])
    expect(await pinnedIds(BOB)).toEqual([])

    expect((await pins.togglePinnedSession(ALICE, { sessionId: 'older', pinnedAt: 99 })).map((pin) => pin.sessionId)).toEqual(['newer'])
    await pins.togglePinnedSession(ALICE, { sessionId: 'older', pinnedAt: 1 })
    expect(await pinnedIds(ALICE)).toEqual(['newer', 'older'])
  })

  test("a person's settle or archive ends their pin; a snooze or another person's settle keeps it", async () => {
    for (const sessionId of ['settled', 'archived', 'snoozed', 'settled-by-bob']) {
      await recorded(sessionId)
      await pins.togglePinnedSession(ALICE, { sessionId, pinnedAt: 1 })
    }
    await new states.SessionViewer('settled', ALICE).settle()
    await new states.SessionViewer('archived', ALICE).archive()
    await new states.SessionViewer('snoozed', ALICE).snooze(Date.now() + 60_000)
    await new states.SessionViewer('settled-by-bob', BOB).settle()
    expect((await pinnedIds(ALICE)).sort()).toEqual(['settled-by-bob', 'snoozed'])

    // A return to the list does not restore the pin.
    await new states.SessionViewer('archived', ALICE).returnToList()
    expect((await pinnedIds(ALICE)).sort()).toEqual(['settled-by-bob', 'snoozed'])
  })

  test('a session with no started record is not listed', async () => {
    await pins.togglePinnedSession(ALICE, { sessionId: 'unknown', pinnedAt: 1 })
    expect(await pinnedIds(ALICE)).toEqual([])
  })
})
