import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A watch belongs to a session link and ends with the session's work
 * (docs/plans/pr-watch.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
const URL_7 = 'https://github.com/Acme/Solus/pull/7'
const REPOSITORY = 'github.com/acme/solus'

let dataDir: string
let db: typeof import('@solus/server/db')
let watches: typeof import('@solus/server/data/sessions/pull-request-watches')
let sessionPrs: typeof import('@solus/server/data/sessions/session-pull-requests')
let states: typeof import('@solus/server/data/sessions/session-states')
let rules: typeof import('@solus/server/prs/pr-watch-rules')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-watches-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  watches = await import('@solus/server/data/sessions/pull-request-watches')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  states = await import('@solus/server/data/sessions/session-states')
  rules = await import('@solus/server/prs/pr-watch-rules')
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

async function watchSeven(sessionId = 'session-1') {
  await sessionPrs.linkSessionPullRequest(sessionId, { url: URL_7, source: 'manual', by: PERSON })
  return watches.startPullRequestWatch(sessionId, REPOSITORY, 7, rules.initialWatchState(1_000), 1_000)
}

describe('pull request watches', () => {
  test('a client sees which link is watched', async () => {
    await watchSeven()
    const [link] = (await sessionPrs.readSessionPullRequests('local', ['session-1']))['session-1'] ?? []
    expect(link?.watch).toEqual({ startedAt: 1_000 })
  })

  test('a read that finishes after a stop, or after the watch started over, writes nothing', async () => {
    // WHY: the read runs for seconds. A person's Stop in that time must win,
    // and a new watch must not get the old watch's state.
    const first = await watchSeven()
    const restarted = await watches.startPullRequestWatch('session-1', REPOSITORY, 7, rules.initialWatchState(2_000), 2_000)
    expect(await watches.recordPullRequestWatchState(first, { ...first.state, conflicting: true })).toBe(false)
    expect(await watches.endPullRequestWatch(first)).toBe(false)
    expect((await watches.readPullRequestWatches(['session-1']))[0]?.watchId).toBe(restarted.watchId)

    await watches.stopPullRequestWatch('session-1', REPOSITORY, 7)
    expect(await watches.recordPullRequestWatchState(restarted, { ...restarted.state, conflicting: true })).toBe(false)
    expect(await watches.readPullRequestWatches()).toEqual([])
  })

  test('the stored state survives a restart', async () => {
    const watch = await watchSeven()
    const told = { ...watch.state, headSha: 'abc', failedChecks: ['build'] }
    expect(await watches.recordPullRequestWatchState(watch, told)).toBe(true)
    expect((await watches.readPullRequestWatches(['session-1']))[0]?.state).toEqual(told)
  })

  test('unlinking the pull request and settling the session end its watches, and say so', async () => {
    const changed: string[] = []
    const stopListening = watches.onPullRequestWatchesChanged((sessionId) => changed.push(sessionId))
    await watchSeven('session-1')
    await sessionPrs.unlinkSessionPullRequest('session-1', REPOSITORY, 7)
    expect(await watches.readPullRequestWatches(['session-1'])).toEqual([])

    await watchSeven('session-2')
    await states.settleSession('session-2', 'person')
    expect(await watches.readPullRequestWatches(['session-2'])).toEqual([])
    stopListening()
    expect(changed).toEqual(['session-1', 'session-1', 'session-2', 'session-2'])
  })
})
