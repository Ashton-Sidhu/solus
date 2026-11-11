import { describe, expect, test } from 'bun:test'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
// The fixture barrel resolves its JSON through `import.meta.glob`, which only
// exists under Vite — the files are read directly here.
import type { DemoFixtures, ReplayStep } from '../../apps/client/src/demo/fixtures/types'
import persistedTabs from '../../apps/client/src/demo/fixtures/data/persisted-tabs.json'
import diffs from '../../apps/client/src/demo/fixtures/data/diffs.json'
import tasks from '../../apps/client/src/demo/fixtures/data/tasks.json'
import replayScript from '../../apps/client/src/demo/fixtures/data/replay-script.json'
import pr from '../../apps/client/src/demo/fixtures/data/pr.json'
import sessions from '../../apps/client/src/demo/fixtures/data/sessions.json'
import { demoTurnRecords, turnListingResult, turnPageResult, turnListingSummaryResult } from '../../apps/client/src/demo/fixtures/insights'
import { answerFor, sqlSessionId, sqlWindow } from '../../apps/client/src/demo/fixtures/insights-answers'
import { defaultExploreSql, sessionTurnsSql, sqlPresets } from '@solus/workspace-ui/components/insights/lib/insights-queries'
import { DEFAULT_TIME_RANGE, resolveRange } from '@solus/workspace-ui/components/insights/lib/time-range'
import { toTurnRows } from '@solus/workspace-ui/components/insights/lib/turn-rows'
import { DemoBackend } from '../../apps/client/src/demo/server'
import { DemoStore } from '../../apps/client/src/demo/store'
import { devFixtures } from '../../apps/client/src/demo/fixtures/dev-fixture'
import { registerBootHandlers } from '../../apps/client/src/demo/handlers/boot'
import { registerPrHandlers } from '../../apps/client/src/demo/handlers/pr'
import { registerTasksHandlers } from '../../apps/client/src/demo/handlers/tasks'
import { parseTaskKey, taskSourceKey } from '@solus/contracts/task-sources'
import type { Task, TaskDetails, TaskSidebarSnapshot } from '@solus/contracts/task-types'
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

    expect(await backend.handle('isVisible', [], TEST_HANDLER_CTX)).toBe(true)
  })
})

describe('demo diff fixtures', () => {
  // The demo's diff lookup is keyed by `IpcContext.session.sessionId`, which is
  // the persisted tab's `sessionId` — not its `tabId` and not its
  // `agentSessionId`. Keying the fixture by either of the others produced no
  // error, just an empty working-tree and session diff for every tab. A session
  // the visitor opens from the sidebar or an agent card gets a tab whose
  // `sessionId` is its session record's id, so that id is a valid key too.
  test('every diff is keyed by the session id a tab sends', () => {
    const sessionIds = new Set([
      ...demoFixtures.persistedTabs.tabs.map((tab) => tab.sessionId),
      ...sessions.map((session) => session.meta.sessionId),
    ])
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
    const taskIds = new Set(demoFixtures.tasks.tasks.map((task) => task.id))
    for (const taskId of Object.keys(demoFixtures.tasks.sessions)) {
      expect(taskIds).toContain(taskId)
    }
  })
})

describe('demo task sources', () => {
  const sourcesByKey = new Map(demoFixtures.tasks.sources.map((source) => [source.sourceKey, source]))

  // A client joins a task to its board through the source key, and a host
  // derives that key from the source. A fixture key that is typed by hand and
  // differs gives a board with no cards and no error.
  test('each source is named by the key of its source', () => {
    expect(demoFixtures.tasks.sources.length).toBeGreaterThan(1)
    for (const source of demoFixtures.tasks.sources) {
      expect(source.sourceKey).toBe(taskSourceKey(source.source))
    }
    expect(sourcesByKey.has(demoFixtures.tasks.defaultSourceKey!)).toBe(true)
  })

  test('each task has a task key and is in a column of a demo source', () => {
    for (const task of demoFixtures.tasks.tasks) {
      expect(parseTaskKey(task.id)?.provider, task.id).toBe(task.providerId)
      expect(task.placements.length, task.id).toBeGreaterThan(0)
      for (const placement of task.placements) {
        const columnIds = sourcesByKey.get(placement.sourceKey)?.columns.map((column) => column.id)
        expect(columnIds, task.id).toContain(placement.columnId!)
      }
    }
  })

  // The rule on `Task.category`: a board and a mixed view must not disagree
  // about whether a task is done.
  test('each task category follows its state and its columns', () => {
    for (const task of demoFixtures.tasks.tasks) {
      const columnCategories = task.placements.map((placement) =>
        sourcesByKey.get(placement.sourceKey)?.columns.find((column) => column.id === placement.columnId)?.category)
      const expected = task.state.category === 'done'
        ? 'done'
        : task.state.category === 'active' || columnCategories.includes('active') ? 'active' : 'open'
      expect(task.category, task.id).toBe(expected)
    }
  })

  // Only a draft has no page on its provider; an issue without a reference or
  // a URL cannot be opened or named in a prompt.
  test('a draft has no reference or URL, and an issue has both', () => {
    expect(demoFixtures.tasks.tasks.some((task) => task.kind === 'draft')).toBe(true)
    for (const task of demoFixtures.tasks.tasks) {
      expect(Boolean(task.reference), task.id).toBe(task.kind === 'issue')
      expect(Boolean(task.url), task.id).toBe(task.kind === 'issue')
    }
  })
})

describe('demo task writes', () => {
  const taskFixture = demoFixtures.tasks
  const githubSourceKey = 'github-project:acme/4'
  const jiraSourceKey = 'jira-board:acme-cloud/12'
  const issueId = 'github:I_kwDOWebDash058'

  function demoTasks() {
    const backend = new DemoBackend()
    registerTasksHandlers(backend, new DemoStore({ ...devFixtures, tasks: taskFixture }))
    // SAFETY: each test names a task method and reads the result that method declares.
    const call = async <T>(method: Parameters<typeof backend.handle>[0], ...args: unknown[]) =>
      await backend.handle(method, args, TEST_HANDLER_CTX) as T
    return { backend, call }
  }

  test('a move to a column gives the state the provider would report', async () => {
    const { call } = demoTasks()
    const review = await call<Task>('tasksMove', issueId, { sourceKey: githubSourceKey, columnId: 'in-review' })
    expect(review.placements).toEqual([{ sourceKey: githubSourceKey, columnId: 'in-review' }])
    // A GitHub issue stays Open on an active column: only the category says active.
    expect(review.state).toEqual({ name: 'Open', category: 'open' })
    expect(review.category).toBe('active')

    const done = await call<Task>('tasksMove', issueId, { category: 'done' })
    expect(done.placements[0].columnId).toBe('done')
    expect(done.state).toEqual({ name: 'Closed', category: 'done' })
    expect(done.category).toBe('done')
  })

  test('a write names the task and its sources to every client', async () => {
    const { backend, call } = demoTasks()
    const seen: string[] = []
    backend.events.subscribe('tasks.invalidated', ({ taskId }) => seen.push(`task ${taskId}`))
    backend.events.subscribe('tasks.sourcesChanged', ({ sourceKeys }) => seen.push(`sources ${sourceKeys.join()}`))
    await call<Task>('tasksMove', issueId, { category: 'active' })
    expect(seen).toEqual([`task ${issueId}`, `sources ${githubSourceKey}`])
  })

  test('a new task is a draft in a GitHub Project and an issue in Jira', async () => {
    const { call } = demoTasks()
    const draft = await call<Task>('tasksCreate', { cwd: '/home/demo/api-gateway', title: 'Try a sliding window' })
    expect(draft).toMatchObject({ kind: 'draft', providerId: 'github', url: null })
    expect(draft.reference).toBeUndefined()
    expect(draft.placements).toEqual([{ sourceKey: githubSourceKey, columnId: 'backlog' }])

    const issue = await call<Task>('tasksCreate', { cwd: '/home/demo/api-gateway', sourceKey: jiraSourceKey, title: 'Audit key scopes', columnId: 'in-progress' })
    expect(issue).toMatchObject({ kind: 'issue', providerId: 'jira', category: 'active', state: { name: 'In Progress', category: 'active' } })
    expect(issue.reference).toMatch(/^ACME-\d+$/)
    expect(parseTaskKey(issue.id)).toMatchObject({ provider: 'jira', cloudId: 'acme-cloud' })
  })

  // A provider keeps its issues: only a draft item can go.
  test('only a draft can be deleted', async () => {
    const { call } = demoTasks()
    await expect(call<boolean>('tasksDelete', issueId)).rejects.toThrow()
    expect(await call<boolean>('tasksDelete', 'github:PVTI_demoBatchTokens')).toBe(true)
    const snapshot = await call<TaskSidebarSnapshot>('tasksSidebarSnapshot')
    expect(snapshot.tasks.map((task) => task.id)).not.toContain('github:PVTI_demoBatchTokens')
    expect(snapshot.tasks.map((task) => task.id)).toContain(issueId)
  })

  test('an unsent comment can be sent again or discarded, a sent one cannot', async () => {
    const { call } = demoTasks()
    const taskId = 'jira:acme-cloud:10214'
    const before = await call<TaskDetails>('tasksGet', taskId)
    const unsent = before.comments.find((comment) => comment.unsent)!
    expect(unsent.sendError).toBeTruthy()

    const retried = await call<TaskDetails>('tasksRetryComment', taskId, unsent.id)
    expect(retried.comments.some((comment) => comment.unsent)).toBe(false)
    expect(retried.comments.length).toBe(before.comments.length)
    await expect(call<TaskDetails>('tasksDeleteComment', taskId, unsent.id)).rejects.toThrow()
  })

  test('a field the task does not take is refused', async () => {
    const { call } = demoTasks()
    await expect(call<Task>('tasksUpdate', 'github:PVTI_demoBatchTokens', { priority: 'high' })).rejects.toThrow()
    const renamed = await call<Task>('tasksUpdate', 'github:PVTI_demoBatchTokens', { title: 'Batch token cost', assignee: 'acme-dev' })
    expect(renamed).toMatchObject({ title: 'Batch token cost', assignee: 'acme-dev' })
  })
})

describe('demo pull request', () => {
  const prFixture = pr as unknown as DemoFixtures['pr']
  const ctx = { session: { projectPath: '/home/demo/api-gateway' } }
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
    const target = await backend.handle('prOpenReview', [ctx, listed.number], TEST_HANDLER_CTX) as PrReviewTarget
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
      ['prSetInterest', [ctx, [{ kind: 'needs-review' }]]],
      ['providerViewer', [ctx]],
    ]
    for (const [method, args] of reads) {
      // SAFETY: every name above is an RPC method the demo registers.
      expect(await backend.handle(method as Parameters<typeof backend.handle>[0], args, TEST_HANDLER_CTX), method).not.toBeNull()
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

  // The page opens on `metricsTurnPage` and `metricsTurnListingSummary`, not on the SQL
  // handlers below them: the default listing is paginated on the host. Leaving it unanswered left the
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
    const summary = turnListingSummaryResult(turns, { timeRange: window })

    expect(summary.totalRows).toBe(inWindow.length)
    expect(page.page.rows.length).toBe(5)
    expect(summary.stats.counted).toBe(inWindow.length)
    // The histogram under the list describes the whole window, not the page.
    expect(summary.volume.reduce((total, bucket) => total + bucket.total, 0)).toBe(inWindow.length)
    expect(toTurnRows(page.page)[0].startedAt).toBe(Math.max(...inWindow.map((turn) => turn.startedAt)))
  })

  // Narrowing to failures must not empty the chips that offer the way back, so
  // the counts are taken before the status filter and the stats after it.
  test('a status filter narrows the rows but not the counts that undo it', () => {
    const window = resolveRange(DEFAULT_TIME_RANGE, now)
    const all = turnListingSummaryResult(turns, { timeRange: window })
    const failures = turnListingSummaryResult(turns, { timeRange: window, status: 'error' })

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
