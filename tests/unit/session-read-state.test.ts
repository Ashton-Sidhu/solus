import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { UNSETTLED_SESSION_STATE } from '@solus/contracts/session-state'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let dataDir: string
let states: typeof import('@solus/server/data/sessions/session-states')
let db: typeof import('@solus/server/db')
const previousDataDir = process.env.SOLUS_DATA_DIR
const ALICE = 'user:alice'
const BOB = 'user:bob'

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
  test('reading a session records the boundary, by its session id, for the reader', async () => {
    // WHY: read state is the session's (docs/plans/session-identity.md), so a
    // provider switch keeps it, and it is the reader's own (plans/029 §4.2): on
    // an organization session Alice reading must not mark it read for Bob.
    const at = Date.now() - 1_000
    expect(await states.markSessionViewed('s1', ALICE, at)).toBe(at)
    expect(await states.markSessionViewed('s1', ALICE, at - 1)).toBe(at)
    expect(await states.viewedAtFor(ALICE, ['s1'])).toEqual(new Map([['s1', at]]))
    expect(await states.viewedAtFor(BOB, ['s1'])).toEqual(new Map())
  })

  test('a client clock ahead of the host cannot mark future work read', async () => {
    // WHY: the boundary decides what counts as already seen. A client an hour
    // fast would silently mark the next hour of completions read.
    const future = Date.now() + 60 * 60 * 1000
    expect(await states.markSessionViewed('s1', ALICE, future)).toBeLessThanOrEqual(Date.now())
  })

  test('the boundary never moves backward', async () => {
    // WHY: two devices reading the same session race. An older view arriving
    // second must not rewind what the newer one already established.
    const newer = Date.now() - 1_000
    await states.markSessionViewed('s2', ALICE, newer)
    expect(await states.markSessionViewed('s2', ALICE, newer - 5_000)).toBe(newer)
  })

  test('marking unread is the one thing that clears the boundary, and only the reader hears it', async () => {
    const heard: Array<[string, string, number | null]> = []
    const stop = states.onSessionReadStateChanged((change) => heard.push([change.sessionId, change.personKey, change.viewedAt]))
    const viewedAt = Date.now() - 1_000
    try {
      await states.markSessionViewed('s3', ALICE, viewedAt)
      await states.markSessionViewed('s3', BOB, viewedAt)
      await states.markSessionUnread('s3', ALICE)
    } finally {
      stop()
    }
    expect(heard).toEqual([['s3', ALICE, viewedAt], ['s3', BOB, viewedAt], ['s3', ALICE, null]])
    // A late view of an earlier moment lands again: it is older than nothing now. Bob's boundary stands.
    const earlier = viewedAt - 5_000
    expect(await states.markSessionViewed('s3', ALICE, earlier)).toBe(earlier)
    expect(await states.viewedAtFor(BOB, ['s3'])).toEqual(new Map([['s3', viewedAt]]))
  })

  test('a read session is still active', async () => {
    // WHY: a row that exists only to hold read state must not settle the session.
    await states.markSessionViewed('s1', ALICE, Date.now() - 1_000)
    expect(await new states.SessionShelf('s1').state()).toEqual(UNSETTLED_SESSION_STATE)
  })
})
