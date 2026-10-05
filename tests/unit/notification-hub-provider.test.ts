import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { PullRequest } from '@solus/contracts/providers'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/015-notifications-hub.md v2 §5, stage 2: pull request assignments and
// review requests are recorded from answers an existing authorized refresh read;
// the observer asks the code host nothing. The first answer is a quiet baseline;
// a later one records one event per new request; a request that went away and
// came back is a new event; an answer recorded but not saved as the baseline
// records nothing twice; and a machine whose credential has no single owner
// records nothing.

let observerModule: typeof import('@solus/server/notifications/pr-observer')
let store: typeof import('@solus/server/data/notifications/store')
let database: typeof import('@solus/server/db/database')
let legacy: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-notification-provider-'))
  process.env.SOLUS_DATA_DIR = dataDir
  observerModule = await import('@solus/server/notifications/pr-observer')
  store = await import('@solus/server/data/notifications/store')
  database = await import('@solus/server/db/database')
  legacy = await import('@solus/server/db')
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

beforeEach(async () => {
  await database.getDatabase().run(sql`DELETE FROM notifications`)
  legacy.getDb().exec('DELETE FROM notification_pr_observations')
})

const repo = { host: 'github.com', owner: 'acme', repo: 'api' }

function pr(number: number, fields: { reviewers?: string[]; assignees?: string[] }): PullRequest {
  // SAFETY: the observer reads only these fields; a fixture names nothing else.
  return {
    number, title: `Change ${number}`, url: `https://github.com/acme/api/pull/${number}`,
    requestedReviewers: (fields.reviewers ?? []).map((login) => ({ login })), assignees: fields.assignees ?? [],
  } as unknown as PullRequest
}

function observer() {
  let clock = 1_000
  const instance = new observerModule.PrObserver({ recipient: () => 'local:owner', organizationId: () => 'local', now: () => clock })
  return { observe: (rows: PullRequest[]) => { clock += 60_000; return instance.observe(repo, 'Octo', rows) } }
}

const inbox = async () => (await store.listNotifications({ scope: 'local', recipientKey: 'local:owner' }, {})).items

describe('pull request observation', () => {
  test('the first answer is a quiet baseline; a later new request is recorded once', async () => {
    const { observe } = observer()
    await observe([pr(1, { reviewers: ['octo'] })])
    expect(await inbox()).toEqual([])

    await observe([pr(1, { reviewers: ['octo'] }), pr(2, { reviewers: ['someone'], assignees: ['OCTO'] }), pr(3, { reviewers: ['Octo'] })])
    const rows = await inbox()
    expect(rows.map((row) => [row.facts.kind, row.resource.kind === 'pr' && row.resource.pr.number]).sort())
      .toEqual([['pr.assigned', 2], ['pr.review_requested', 3]])
    expect(rows[0]!.by).toEqual({ kind: 'upstream', provider: 'github' })

    await observe([pr(1, { reviewers: ['octo'] }), pr(2, { assignees: ['octo'] }), pr(3, { reviewers: ['octo'] })])
    expect(await inbox()).toHaveLength(2)
  })

  test('a request that went away and came back is a new event', async () => {
    const { observe } = observer()
    await observe([])
    await observe([pr(9, { reviewers: ['octo'] })])
    await observe([])
    await observe([pr(9, { reviewers: ['octo'] })])
    expect(await inbox()).toHaveLength(2)
  })

  test('an answer recorded but not saved as the baseline records nothing twice', async () => {
    const { observe } = observer()
    await observe([])
    const baseline = legacy.getDb().prepare('SELECT pending, observed_at FROM notification_pr_observations').get() as { pending: string; observed_at: number }
    await observe([pr(4, { reviewers: ['octo'] })])
    legacy.getDb().prepare('UPDATE notification_pr_observations SET pending = ?, observed_at = ?').run(baseline.pending, baseline.observed_at)
    await observe([pr(4, { reviewers: ['octo'] })])
    expect(await inbox()).toHaveLength(1)
  })

  test('a machine whose credential has no single owner records nothing', async () => {
    const instance = new observerModule.PrObserver({ recipient: () => null, organizationId: () => 'local' })
    await instance.observe(repo, 'octo', [pr(1, { reviewers: ['octo'] })])
    expect(legacy.getDb().prepare('SELECT COUNT(*) AS count FROM notification_pr_observations').get()).toEqual({ count: 0 })
  })
})
