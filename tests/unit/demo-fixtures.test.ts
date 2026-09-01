import { describe, expect, test } from 'bun:test'
// The fixture barrel resolves its JSON through `import.meta.glob`, which only
// exists under Vite — the files are read directly here.
import type { DemoFixtures, ReplayStep } from '../../apps/client/src/demo/fixtures/types'
import persistedTabs from '../../apps/client/src/demo/fixtures/data/persisted-tabs.json'
import diffs from '../../apps/client/src/demo/fixtures/data/diffs.json'
import tasks from '../../apps/client/src/demo/fixtures/data/tasks.json'
import replayScript from '../../apps/client/src/demo/fixtures/data/replay-script.json'
import pr from '../../apps/client/src/demo/fixtures/data/pr.json'
import { demoTurnRecords, turnListingResult, turnPageResult } from '../../apps/client/src/demo/fixtures/insights'
import { answerFor, sqlSessionId, sqlWindow } from '../../apps/client/src/demo/fixtures/insights-answers'
import { defaultExploreSql, sessionTurnsSql, sqlPresets } from '@solus/workspace-ui/components/insights/lib/insights-queries'
import { DEFAULT_TIME_RANGE, resolveRange } from '@solus/workspace-ui/components/insights/lib/time-range'
import { toTurnRows } from '@solus/workspace-ui/components/insights/lib/turn-rows'
import { DemoBackend } from '../../apps/client/src/demo/server'
import { DemoStore } from '../../apps/client/src/demo/store'
import { devFixtures } from '../../apps/client/src/demo/fixtures/dev-fixture'
import { registerBootHandlers } from '../../apps/client/src/demo/handlers/boot'
import { registerPrHandlers } from '../../apps/client/src/demo/handlers/pr'
import type { PrReviewTarget, PullRequest, PullRequestOverview } from '@solus/contracts/providers'

// The demo backend is the only implementation of the RPC surface that no
// integration test exercises: it runs in a page the visitor cannot report from.
// These tests hold the contracts a fixture can silently break.

const demoFixtures = {
  persistedTabs: persistedTabs as DemoFixtures['persistedTabs'],
  diffs: diffs as unknown as DemoFixtures['diffs'],
  tasks: tasks as unknown as DemoFixtures['tasks'],
  replayScript: replayScript as unknown as ReplayStep[],
}

describe('demo client shell', () => {
  test('reports itself visible so replay events never play notification audio', async () => {
    const backend = new DemoBackend()
    registerBootHandlers(backend, new DemoStore(devFixtures))

    expect(await backend.handle('isVisible', [])).toBe(true)
  })
})

describe('demo diff fixtures', () => {
  // The demo's diff lookup is keyed by `IpcContext.session.sessionId`, which is
  // the persisted tab's `sessionId` — not its `tabId` and not its
  // `agentSessionId`. Keying the fixture by either of the others produced no
  // error, just an empty working-tree and session diff for every tab.
  test('every diff is keyed by a persisted tab session id', () => {
    const sessionIds = new Set(demoFixtures.persistedTabs.tabs.map((tab) => tab.sessionId))
    for (const key of Object.keys(demoFixtures.diffs)) {
      expect(sessionIds).toContain(key)
    }
  })

  test('the session the replay drives has a diff to show', () => {
    const replaySessionId = demoFixtures.replayScript[0]?.sessionId
    expect(replaySessionId).toBeTruthy()
    expect(demoFixtures.diffs[replaySessionId!]?.stats.length).toBeGreaterThan(0)
  })
})

describe('demo task links', () => {
  // The task crumb in the breadcrumb and the Task card in the project panel
  // both resolve through the session's agent session id. A tab whose session is
  // linked to no task shows neither, and the demo then reads as if Solus had no
  // task system at all.
  test('every started tab is linked to a task', () => {
    const linkedSessionIds = new Set(
      Object.values(demoFixtures.tasks.sessions).flat().map((link) => link.sessionId),
    )
    const startedTabs = demoFixtures.persistedTabs.tabs.filter((tab) => tab.agentSessionId)
    expect(startedTabs.length).toBeGreaterThan(0)
    for (const tab of startedTabs) {
      expect(linkedSessionIds).toContain(tab.agentSessionId!)
    }
  })

  test('each linked task exists in the demo task list', () => {
    const taskIds = new Set(demoFixtures.tasks.list.tasks.map((task) => task.id))
    for (const taskId of Object.keys(demoFixtures.tasks.sessions)) {
      expect(taskIds).toContain(taskId)
    }
  })
})

describe('demo pull request', () => {
  const prFixture = pr as unknown as DemoFixtures['pr']
  const ctx = { session: { projectPath: '/home/demo/acme' } }
  const backend = new DemoBackend()
  registerPrHandlers(backend, new DemoStore({ ...devFixtures, pr: prFixture }))

  // The captured overview is read as a `PullRequestOverview`, and the whole
  // review opens off `overview.pullRequest`. Naming that field anything else
  // costs no error at capture time and no type error in the demo, and turns
  // every click on a pull request into "Couldn't open PR".
  test('the captured overview is the pull request the list rows name', () => {
    const overview: PullRequestOverview = prFixture.overview
    expect(overview.pullRequest.number).toBe(prFixture.list[0].number)
  })

  // A row carries everything the actions opened from it need — the head it is
  // reviewed at, the page it opens on its host — so a click never has to go
  // back to the list for a field the row should already have stated.
  test('a listed pull request is complete enough to act on', () => {
    for (const listed of prFixture.list) {
      for (const field of ['url', 'headSha', 'baseSha', 'headRef', 'baseRef'] satisfies Array<keyof PullRequest>) {
        expect(listed[field], `list row #${listed.number} has no ${field}`).toBeTruthy()
      }
    }
  })

  test('clicking a listed pull request resolves the review it opens', async () => {
    const listed = prFixture.list[0]
    // SAFETY: `prOpenReview` is registered above and returns the demo's target.
    const target = await backend.handle('prOpenReview', [ctx, listed.number]) as PrReviewTarget
    expect(target.number).toBe(listed.number)
    expect(target.headSha).toBe(listed.headSha)
  })

  // Everything the review surface reads the moment a row is clicked. An
  // unanswered method resolves to null here, which is not a slow surface but a
  // crashed one — the store assigns the null straight into its state.
  test('every read the open review makes is answered', async () => {
    const listed = prFixture.list[0]
    const reads: Array<[string, unknown[]]> = [
      ['prGetOverview', [ctx, listed.number]],
      ['prGetDetail', [ctx, listed.number]],
      ['prListComments', [ctx, listed.number]],
      ['prListThreads', [ctx, listed.number]],
      ['prListCommits', [ctx, listed.number]],
      ['prListReviewers', [ctx, listed.number]],
      ['prChangedFiles', [ctx, listed.number]],
      ['prChecks', [ctx, [listed.number]]],
      ['prNeedsReview', [ctx]],
      ['providerViewer', [ctx]],
    ]
    for (const [method, args] of reads) {
      // SAFETY: every name above is an RPC method the demo registers.
      expect(await backend.handle(method as Parameters<typeof backend.handle>[0], args), method).not.toBeNull()
    }
  })
})

describe('demo insights answers', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z')
  const turns = demoTurnRecords(now)

  test('the recorded turns fill the default window', () => {
    const window = resolveRange(DEFAULT_TIME_RANGE, now)
    const inWindow = turns.filter((turn) => turn.startedAt >= window.from && turn.startedAt < window.to)
    expect(inWindow.length).toBeGreaterThan(8)
    // A histogram of one status is a flat demo; the fixture carries failures.
    expect(new Set(inWindow.map((turn) => turn.status)).size).toBeGreaterThan(1)
  })

  test('the listing reads back as turn rows', () => {
    const rows = toTurnRows(turnListingResult(turns))
    expect(rows.length).toBe(turns.length)
    expect(rows[0].prompt).toBe(turns[0].prompt)
    expect(rows[0].traceId).toBe(turns[0].traceId)
  })

  // The explore statement and the session drill-in must fall through to the
  // listing, not to a rollup — a preset matcher that caught them would replace
  // the turn list with a grouped grid.
  test('the shipped explore statements resolve to the listing', () => {
    for (const sql of [defaultExploreSql(DEFAULT_TIME_RANGE), sessionTurnsSql('demo-session-ratelimit', DEFAULT_TIME_RANGE)]) {
      expect(answerFor(sql)).toBeNull()
    }
    expect(sqlSessionId(sessionTurnsSql('demo-session-ratelimit', DEFAULT_TIME_RANGE))).toBe('demo-session-ratelimit')
    expect(sqlSessionId(defaultExploreSql(DEFAULT_TIME_RANGE))).toBeNull()
  })

  test('every preset chip is answered, and each by its own rollup', () => {
    const matched = sqlPresets(DEFAULT_TIME_RANGE).map((preset) => {
      const answer = answerFor(preset.text)
      expect(answer, `no demo answer for preset ${preset.id}`).not.toBeNull()
      return answer!.id
    })
    expect(new Set(matched).size).toBe(matched.length)
  })

  // The page opens on `metricsTurnPage`, not on the SQL handlers below it: the
  // default listing is paginated on the host. Leaving it unanswered left the
  // demo's Insights page opening on an error instead of its own recorded turns.
  test('the default listing is paged, counted and bucketed', () => {
    const window = resolveRange(DEFAULT_TIME_RANGE, now)
    const inWindow = turns.filter((turn) => turn.startedAt >= window.from && turn.startedAt < window.to)
    const page = turnPageResult(turns, {
      timeRange: window,
      pageIndex: 0,
      pageSize: 5,
      sort: { field: 'started_at', dir: 'desc' },
    })

    expect(page.totalRows).toBe(inWindow.length)
    expect(page.page.rows.length).toBe(5)
    expect(page.stats.counted).toBe(inWindow.length)
    // The histogram under the list describes the whole window, not the page.
    expect(page.volume.reduce((total, bucket) => total + bucket.total, 0)).toBe(inWindow.length)
    expect(toTurnRows(page.page)[0].startedAt).toBe(Math.max(...inWindow.map((turn) => turn.startedAt)))
  })

  // Narrowing to failures must not empty the chips that offer the way back, so
  // the counts are taken before the status filter and the stats after it.
  test('a status filter narrows the rows but not the counts that undo it', () => {
    const window = resolveRange(DEFAULT_TIME_RANGE, now)
    const request = {
      timeRange: window,
      pageIndex: 0,
      pageSize: 25,
      sort: { field: 'started_at', dir: 'desc' } as const,
    }
    const all = turnPageResult(turns, request)
    const failures = turnPageResult(turns, { ...request, status: 'error' as const })

    expect(failures.statusCounts).toEqual(all.statusCounts)
    expect(failures.stats.counted).toBe(all.statusCounts.error)
    expect(failures.stats.failureRate).toBe(1)
  })

  test('a relative window is read off the statement it was written into', () => {
    const window = sqlWindow(defaultExploreSql({ kind: 'relative', ms: 3_600_000 }), now)
    expect(window.from).toBe(now - 3_600_000)
    expect(sqlWindow(defaultExploreSql({ kind: 'absolute', from: 10, to: 20 }), now)).toEqual({ from: 10, to: 20 })
  })
})
