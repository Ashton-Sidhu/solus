import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * One tool starts and stops a watch (docs/plans/pr-watch.md §1), and it
 * refuses a watch that nothing would act on.
 */

const URL_7 = 'https://github.com/acme/solus/pull/7'
const REPOSITORY = 'github.com/acme/solus'

let tool: typeof import('@solus/server/execution/agents/tools/pull-request-watch-tool')
let watches: typeof import('@solus/server/data/sessions/pull-request-watches')
let sessionPrs: typeof import('@solus/server/data/sessions/session-pull-requests')
let states: typeof import('@solus/server/data/sessions/session-states')
let closeDb: typeof import('@solus/server/db')['closeDb']
let acting: typeof import('@solus/server/execution/seats/acting-identity')
let actingScope: typeof import('@solus/server/vault/acting-scope')
let start: typeof import('@solus/server/prs/start-pull-request-watch')
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

function toolContext(sessionId: string) {
  return { cwd: process.cwd(), sessionId: () => sessionId, emit: () => {} } as never
}

beforeEach(async () => { await installTestWorkspaceTools() })

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-watch-tool-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tool = await import('@solus/server/execution/agents/tools/pull-request-watch-tool')
  watches = await import('@solus/server/data/sessions/pull-request-watches')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  states = await import('@solus/server/data/sessions/session-states')
  ;({ closeDb } = await import('@solus/server/db'))
  acting = await import('@solus/server/execution/seats/acting-identity')
  actingScope = await import('@solus/server/vault/acting-scope')
  start = await import('@solus/server/prs/start-pull-request-watch')
  // An agent tool call runs in its turn's scope; these calls are the host's.
  acting.actAsHostForTests()
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('watch_pull_request', () => {
  test('links the pull request, watches it, and stops with watching=false', async () => {
    const started = await tool.watchPullRequestAgentTool.execute({ pull_request: URL_7 }, toolContext('session-1'))
    expect(started).toMatchObject({ ok: true })
    expect(started.text).toContain('End your turn')
    const [link] = (await sessionPrs.readSessionPullRequests('local', ['session-1']))['session-1'] ?? []
    expect(link).toMatchObject({ number: 7, source: 'agent', watch: expect.any(Object) })

    const again = await tool.watchPullRequestAgentTool.execute({ pull_request: URL_7 }, toolContext('session-1'))
    expect(again.text).toContain('Already watching')

    const stopped = await tool.watchPullRequestAgentTool.execute({ pull_request: URL_7, watching: false }, toolContext('session-1'))
    expect(stopped).toMatchObject({ ok: true })
    expect(await watches.readPullRequestWatches(['session-1'])).toEqual([])
  })

  test('refuses a merged pull request and a settled session', async () => {
    await sessionPrs.linkSessionPullRequest('session-1', { url: URL_7, source: 'manual', by: { kind: 'system' } })
    await sessionPrs.recordSessionPullRequestObservation(REPOSITORY, 7, {
      number: 7, title: 'Done', state: 'merged', draft: false, updatedAt: '2026-10-07T12:00:00Z',
    } as never)
    const merged = await tool.watchPullRequestAgentTool.execute({ pull_request: URL_7 }, toolContext('session-1'))
    expect(merged).toMatchObject({ ok: false })
    expect(merged.text).toContain('merged')

    await states.settleSession('session-2', 'person')
    const settled = await tool.watchPullRequestAgentTool.execute({ pull_request: URL_7 }, toolContext('session-2'))
    expect(settled).toMatchObject({ ok: false })
    expect(await watches.readPullRequestWatches()).toEqual([])
  })

  test('a watch reads with the account of the person it was started for', async () => {
    // WHY: the watcher reads later, from its own clock, where nobody is acting.
    // Reading as the host would use the host's GitHub for a member's pull request.
    await sessionPrs.linkSessionPullRequest('session-1', { url: URL_7, source: 'manual', by: { kind: 'system' } })
    const member = { identity: acting.HOST_IDENTITY, credentialUserId: 'member-1' }
    expect(await actingScope.withActingScope(member, () => start.startSessionPullRequestWatch('session-1', REPOSITORY, 7))).toBe('started')
    expect((await watches.readPullRequestWatches(['session-1']))[0]?.actingUserKey).toBe('member-1')
  })
})
