import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let dataDir: string
let states: typeof import('@solus/server/data/sessions/session-states')
let db: typeof import('@solus/server/db')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-read-state-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  db.closeDb()
  states = await import('@solus/server/data/sessions/session-states')
})

afterEach(async () => {
  await resetTestDatabase()
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('session read state', () => {
  test('reading a session records the boundary, by its session id', async () => {
    // WHY: read state is the session's (docs/plans/session-identity.md). It
    // lives with the session's state, so a provider switch keeps it.
    const at = Date.now() - 1_000
    expect(await states.markSessionViewed('s1', at)).toBe(at)
    expect(await states.markSessionViewed('s1', at - 1)).toBe(at)
  })

  test('a client clock ahead of the host cannot mark future work read', async () => {
    // WHY: the boundary decides what counts as already seen. A client an hour
    // fast would silently mark the next hour of completions read.
    const future = Date.now() + 60 * 60 * 1000
    expect(await states.markSessionViewed('s1', future)).toBeLessThanOrEqual(Date.now())
  })

  test('the boundary never moves backward', async () => {
    // WHY: two devices reading the same session race. An older view arriving
    // second must not rewind what the newer one already established.
    const newer = Date.now() - 1_000
    await states.markSessionViewed('s2', newer)
    expect(await states.markSessionViewed('s2', newer - 5_000)).toBe(newer)
  })

  test('marking unread is the one thing that clears the boundary', async () => {
    const viewedAt = Date.now() - 1_000
    await states.markSessionViewed('s3', viewedAt)
    await states.markSessionUnread('s3')
    // A late view of an earlier moment lands again: it is older than nothing now.
    const earlier = viewedAt - 5_000
    expect(await states.markSessionViewed('s3', earlier)).toBe(earlier)
  })

  test('a read session is not on the shelf', async () => {
    // WHY: the shelf lists settled and snoozed sessions. A row that exists only
    // to hold read state must not put an active session there.
    await states.markSessionViewed('s1', Date.now() - 1_000)
    expect(await states.readSessionShelf('local')).toEqual([])
  })
})
