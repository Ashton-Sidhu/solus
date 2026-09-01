import { describe, expect, it } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { Task } from '@solus/contracts/task-types'
import {
  completedTasksWithinRetention,
  DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS,
  SIDEBAR_COMPLETED_RETENTION_CHECK_MS,
} from '@solus/workspace-ui/lib/completed-task-retention'
import {
  aggregateReviewGuideStatus,
  buildProjectSummaries,
  formatCompletedAge,
  formatElapsed,
  formatWakeIn,
  filterSidebarTasks,
  groupTasks,
  hasDisclosure,
  maxTaskAttention,
  sidebarChildLabel,
  hasGlyph,
  shouldEmphasizeTitle,
  shouldLeadTitle,
  prChipFor,
  prChipForBranches,
  prChipForChoices,
  dedupePrChoices,
  reconcileSidebarTasks,
  resolveSidebarRowMark,
  resolveTaskSidebarLifecycle,
  shouldCompleteTaskForPr,
  shouldRecedeRow,
  shouldShelveCompletedTask,
  shouldShowDurableSidebarTask,
  showsUnreadIndicator,
  isCompletedTaskSession,
  projectFilterChoices,
  resolveProjectFilter,
  sortTasks,
  taskRowBranchName,
  taskStatusFor,
  type SidebarTask,
  type TaskStatus,
} from '@solus/workspace-ui/components/session/lib/task-list'
import { worktreeDisplayName } from '@solus/workspace-ui/lib/git-context'

describe('sidebar task search', () => {
  const task = (title: string, projectLabel: string): SidebarTask => ({
    id: title,
    key: title,
    title,
    projectKey: projectLabel,
    projectLabel,
    branchName: null,
    serverId: null,
    prNumber: null,
    status: 'idle',
    attention: null,
    unread: false,
    createdAt: 0,
    activityAt: 0,
    runStartedAt: 0,
    lifecycle: 'active',
    completedAt: 0,
    snoozedUntil: 0,
    snoozeNote: null,
    lastReadAt: 0,
    woke: false,
    tabIds: [],
  })
  const tasks = [task('Fix sync status', 'Solus'), task('Update docs', 'Website')]

  it('matches task and project names without changing row order', () => {
    // WHY: a multi-project sidebar needs title search and project context, but
    // filtering must not move the rows the user has learned.
    expect(filterSidebarTasks(tasks, 'SYNC')).toEqual([tasks[0]])
    expect(filterSidebarTasks(tasks, 'website')).toEqual([tasks[1]])
  })

  it('keeps the original task array when the query is blank', () => {
    // WHY: idle search must not invalidate every mounted task row.
    expect(filterSidebarTasks(tasks, '   ')).toBe(tasks)
  })
})


describe('completed task age', () => {
  const now = Date.parse('2026-08-11T12:00:00Z')

  it('keeps completed tasks in the sidebar for two days by default', () => {
    expect(DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS).toBe(2)
  })

  it('checks completed task retention once an hour', () => {
    // WHY: the shelf changes slowly, so a minute-level timer adds needless
    // renderer invalidations without making the retention rule more useful.
    expect(SIDEBAR_COMPLETED_RETENTION_CHECK_MS).toBe(60 * 60 * 1000)
  })

  it('keeps the completed shelf age compact from minutes through days', () => {
    // WHY: completed rows have one narrow trailing column and must not grow
    // into prose or switch to an unrelated calendar-date representation.
    expect(formatCompletedAge(now - 57 * 60_000, now)).toBe('57m')
    expect(formatCompletedAge(now - 6 * 3_600_000, now)).toBe('6h')
    expect(formatCompletedAge(now - 38 * 86_400_000, now)).toBe('38d')
  })

  it('removes completed sidebar tasks when their retention period ends', () => {
    // WHY: completion history is useful briefly, but old rows must leave the
    // session sidebar without deleting or reopening their durable tasks.
    const recent = { completedAt: now - 2 * 86_400_000 + 1 } as SidebarTask
    const expired = { completedAt: now - 2 * 86_400_000 } as SidebarTask
    const unknown = { completedAt: 0 } as SidebarTask

    expect(completedTasksWithinRetention([recent, expired, unknown], 2, now)).toEqual([
      recent,
      unknown,
    ])
  })
})

describe('sidebar lifecycle resolution', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  it('keeps inactive work active until its task status changes', () => {
    expect(resolveTaskSidebarLifecycle({ status: 'in_progress', now }).lifecycle).toBe('active')
  })

  it('puts done rows in Completed ahead of a stale snooze', () => {
    expect(resolveTaskSidebarLifecycle({
      status: 'done',
      doneAt: now - 1,
      snoozedUntil: now + 1,
      now,
    })).toMatchObject({ lifecycle: 'completed', completedAt: now - 1 })
  })

  it('shelves a dropped row instead of stranding it in the active column', () => {
    // WHY: the row's close control writes `dropped`, and the sidebar has always
    // drawn that with the finished glyph. Calling only `done` completed left a
    // row that looked finished, sat among live work, and could not be moved.
    expect(resolveTaskSidebarLifecycle({
      status: 'dropped',
      updatedAt: now - 5,
      now,
    })).toMatchObject({ lifecycle: 'completed', completedAt: now - 5 })
  })

  it('dates a finished row from its last change when no completion time was recorded', () => {
    // WHY: `doneAt` is only written for `done`, and rows finished before the
    // store recorded it have none at all. Without a fallback the row reports no
    // age and sorts under every dated row on the shelf.
    expect(resolveTaskSidebarLifecycle({
      status: 'done',
      updatedAt: now - 3,
      now,
    })).toMatchObject({ lifecycle: 'completed', completedAt: now - 3 })
  })

  it('prefers the recorded completion time over the last change', () => {
    expect(resolveTaskSidebarLifecycle({
      status: 'done',
      doneAt: now - 7,
      updatedAt: now - 1,
      now,
    }).completedAt).toBe(now - 7)
  })

  it('returns an expired snooze with a woke marker until it is read', () => {
    expect(resolveTaskSidebarLifecycle({
      status: 'in_progress',
      snoozedUntil: now - 1,
      lastReadAt: 0,
      now,
    })).toMatchObject({ lifecycle: 'active', woke: true })
  })

  it('keeps a snoozed row on its shelf while its agent is still working', () => {
    // WHY: a snooze defers the row, not the run. Quiet progress is exactly what
    // the user asked not to see, so a turn in flight must not drag it back.
    expect(resolveTaskSidebarLifecycle({
      status: 'in_progress',
      snoozedUntil: now + 1,
      attention: 'running',
      now,
    })).toMatchObject({ lifecycle: 'snoozed', snoozedUntil: now + 1 })
  })

  it('returns a snoozed row whose run stopped to ask for something', () => {
    // WHY: a blocked run is the strongest call for a person there is, and it
    // would otherwise sit unseen behind the shelf until the wake time. The
    // snooze survives, so answering leaves the wake time in force.
    for (const attention of ['awaiting', 'awaiting_plan', 'error'] as const) {
      expect(resolveTaskSidebarLifecycle({
        status: 'in_progress',
        snoozedUntil: now + 1,
        attention,
        now,
      })).toMatchObject({ lifecycle: 'active', snoozedUntil: now + 1 })
    }
  })
})

describe('linked PR completion', () => {
  it('completes a task when its linked PR closes or merges', () => {
    // WHY: either terminal PR result is authoritative for the linked task.
    const task = { status: 'in_progress' as const, updatedAt: 100 }
    expect(shouldCompleteTaskForPr(task, { state: 'closed', updatedAt: new Date(200).toISOString() })).toBe(true)
    expect(shouldCompleteTaskForPr(task, { state: 'merged', updatedAt: new Date(200).toISOString() })).toBe(true)
    expect(shouldCompleteTaskForPr(task, { state: 'open', updatedAt: new Date(200).toISOString() })).toBe(false)
  })

  it('does not close a task again after it was reopened', () => {
    // WHY: reopening is a newer explicit decision than the PR's unchanged
    // closed state. Refreshing or restarting the app must preserve that choice.
    const reopened = { status: 'todo' as const, updatedAt: 300 }
    expect(shouldCompleteTaskForPr(reopened, {
      state: 'closed',
      updatedAt: new Date(200).toISOString(),
    })).toBe(false)
  })
})

function durableTask(status: Task['status'], overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${status}`,
    providerId: 'local',
    kind: 'task',
    title: status,
    body: '',
    status,
    url: null,
    labels: [],
    updatedAt: 0,
    ...overrides,
  }
}

function task(
  key: string,
  status: TaskStatus,
  overrides: Partial<SidebarTask> = {},
): SidebarTask {
  return {
    id: key,
    key,
    title: key,
    projectKey: '/repos/solus',
    projectLabel: 'solus',
    branchName: key,
    status,
    attention: null,
    unread: false,
    createdAt: 0,
    activityAt: 0,
    runStartedAt: 0,
    lifecycle: 'active',
    tabIds: [key],
    ...overrides,
  }
}

describe('shouldShowDurableSidebarTask', () => {
  it('keeps completed and dropped tasks until the user explicitly removes them', () => {
    // Status and age describe the task lifecycle, not whether its sidebar row
    // exists. The explicit remove action is the only way a root row leaves —
    // completing one is that same action, which is why nothing here reads status.
    expect(shouldShowDurableSidebarTask(durableTask('done'), false, false, true)).toBe(true)
    expect(shouldShowDurableSidebarTask(durableTask('dropped'), false, false, true)).toBe(true)
  })

  it('restores a completed task when one of its sessions is reopened', () => {
    // WHY: completion removes the row by dismissing it, so reopening a session
    // has to bring the task back. Hiding a finished task on status instead left
    // the reopened conversation mounted with no row — and unloaded again.
    expect(shouldShowDurableSidebarTask(durableTask('done'), true, true, true)).toBe(true)
  })

  it('restores an open task when a new session explicitly reopens it', () => {
    const task = durableTask('in_progress')
    expect(shouldShowDurableSidebarTask(task, true, false, true)).toBe(false)
    expect(shouldShowDurableSidebarTask(task, true, true, true)).toBe(true)
  })

  it('keeps every host task closed until this client opens it', () => {
    // WHY: connecting a host must not copy any part of its task list into the
    // session sidebar. Status alone is not an open action.
    for (const status of ['todo', 'in_progress', 'in_review'] as const) {
      const task = durableTask(status)
      expect(shouldShowDurableSidebarTask(task, false, false, false)).toBe(false)
      expect(shouldShowDurableSidebarTask(task, false, false, true)).toBe(true)
      expect(shouldShowDurableSidebarTask(task, false, true, false)).toBe(true)
    }
  })

  it('continues to project child tasks through their root row', () => {
    expect(
      shouldShowDurableSidebarTask(durableTask('in_progress', { parentId: 'root' }), false, true, true),
    ).toBe(false)
  })
})

describe('shouldShelveCompletedTask', () => {
  it('shelves finished work this client never had open', () => {
    // WHY: the whole defect. The active column only lists tasks this client has
    // open, and gating the Completed shelf on that same membership erased every
    // task the user finished and put away — the exact ones they go back for.
    for (const status of ['done', 'dropped'] as const) {
      expect(shouldShelveCompletedTask(durableTask(status), false)).toBe(true)
    }
  })

  it('shelves a task the row control dropped, not only one the check marked done', () => {
    // WHY: the sidebar's close control writes `dropped`, and the row already
    // draws it with the finished glyph. Leaving it out of Completed stranded it
    // in the active column with no way to move it.
    expect(shouldShelveCompletedTask(durableTask('dropped'), false)).toBe(true)
  })

  it('leaves unfinished work to the active column', () => {
    for (const status of ['todo', 'in_progress', 'in_review', 'inbox'] as const) {
      expect(shouldShelveCompletedTask(durableTask(status), false)).toBe(false)
    }
  })

  it('never doubles a row the column is already showing', () => {
    expect(shouldShelveCompletedTask(durableTask('done'), true)).toBe(false)
  })

  it('keeps subtasks under their root, as the column does', () => {
    expect(shouldShelveCompletedTask(durableTask('done', { parentId: 'root' }), false)).toBe(false)
  })
})

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return pullRequestFixture(412, {
    title: 'Run host selection',
    headSha: 'abc',
    author: 'ashton',
    createdAt: '',
    updatedAt: '',
    headRef: 'run-host-selection',
    ...overrides,
  })
}

describe('reconcileSidebarTasks', () => {
  it('keeps unrelated row models stable when one task clears its unread state', () => {
    const first = task('first', 'idle', { unread: true })
    const second = task('second', 'running')
    const previousById = new Map([
      [first.id, first],
      [second.id, second],
    ])

    const reconciled = reconcileSidebarTasks(previousById, [
      task('first', 'idle', { unread: false }),
      task('second', 'running'),
    ])

    expect(reconciled[0]).not.toBe(first)
    expect(reconciled[1]).toBe(second)
  })

  it('drops closed task models from the identity cache', () => {
    const first = task('first', 'idle')
    const second = task('second', 'idle')
    const previousById = new Map([
      [first.id, first],
      [second.id, second],
    ])

    reconcileSidebarTasks(previousById, [task('second', 'idle')])

    expect([...previousById.keys()]).toEqual(['second'])
  })
})

describe('sortTasks', () => {
  it('puts a question above a running task from another project', () => {
    // The whole point of flat mode: the sort is on state, not on project. If
    // project won, the row that stopped and asked would sit below busywork.
    const sorted = sortTasks([
      task('running-elsewhere', 'running', {
        projectKey: '/repos/model-routing',
        projectLabel: 'model-routing',
        activityAt: 900,
      }),
      task('asking', 'question', { activityAt: 100 }),
    ])
    expect(sorted.map((t) => t.key)).toEqual(['asking', 'running-elsewhere'])
  })

  it('ranks the full state order: question, error, plan, limit, running, idle, done', () => {
    const sorted = sortTasks([
      task('g', 'done'),
      task('f', 'idle'),
      task('e', 'running'),
      task('d', 'limit'),
      task('c', 'plan'),
      task('b', 'error'),
      task('a', 'question'),
    ])
    expect(sorted.map((t) => t.key)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  })

  it('breaks ties on most recent activity', () => {
    const sorted = sortTasks([
      task('older', 'idle', { activityAt: 10 }),
      task('newer', 'idle', { activityAt: 20 }),
    ])
    expect(sorted.map((t) => t.key)).toEqual(['newer', 'older'])
  })

  it('leaves the caller a copy, so ranking never reorders the list itself', () => {
    // The sidebar renders the array it was given, in the order tasks arrived —
    // a picker asking for a ranking must not be able to shuffle the column.
    const tasks = [task('a', 'idle'), task('b', 'question')]
    sortTasks(tasks)
    expect(tasks.map((t) => t.key)).toEqual(['a', 'b'])
  })
})

describe('groupTasks', () => {
  it('names groups in a fixed order, so a project that starts working stays put', () => {
    const groups = groupTasks([
      task('quiet', 'idle'),
      task('loud', 'question', {
        projectKey: '/repos/model-routing',
        projectLabel: 'model-routing',
      }),
    ])
    expect(groups.map((g) => g.projectLabel)).toEqual(['model-routing', 'solus'])
  })

  it('keeps each group in the order its tasks arrived', () => {
    // Status is carried by the glyph, never by the row's position: a task that
    // fails must report it where the user last saw the task.
    const [group] = groupTasks([task('idle', 'idle'), task('err', 'error')])
    expect(group.tasks.map((t) => t.key)).toEqual(['idle', 'err'])
  })
})

describe('buildProjectSummaries', () => {
  it('counts every project and names what each one wants, in the list\u2019s own words', () => {
    const [solus, routing] = buildProjectSummaries([
      task('a', 'idle'),
      task('b', 'question'),
      task('c', 'error', {
        projectKey: '/repos/model-routing',
        projectLabel: 'model-routing',
      }),
    ])
    expect(solus).toMatchObject({ label: 'solus', count: 2, waiting: 1, failed: 0 })
    expect(routing).toMatchObject({ label: 'model-routing', count: 1, waiting: 0, failed: 1 })
  })

  it('leads each project with its most urgent task, so picking one lands on the decision', () => {
    // The picker exists to move you somewhere useful. Landing on whatever task
    // happens to be first in tab order would make it a navigation dead end.
    const [summary] = buildProjectSummaries([task('idle', 'idle'), task('asks', 'question')])
    expect(summary.leadTaskKey).toBe('asks')
  })
})

describe('resolveProjectFilter', () => {
  it('drops a scope whose project has left the column', () => {
    // A saved filter outlives the project it names. Holding it would leave the
    // column empty and scoped to something no longer in the menu.
    expect(resolveProjectFilter('/repos/gone', [task('a', 'idle')])).toBeNull()
  })

  it('holds a scope whose project has only snoozed or completed work', () => {
    // That list is legitimately empty, and saying so is what the empty line is
    // for. Clearing the scope here would hide the answer the user asked for.
    const shelved = task('a', 'idle', { lifecycle: 'completed' })
    expect(resolveProjectFilter('/repos/solus', [shelved])).toBe('/repos/solus')
  })
})

describe('projectFilterChoices', () => {
  it('offers every open project in the order the column already lists them', () => {
    // Picking a scope must never reorder what you were reading, so the menu
    // follows the list rather than sorting itself.
    const choices = projectFilterChoices([
      task('a', 'idle', {
        projectKey: '/repos/model-routing',
        projectLabel: 'model-routing',
        lifecycle: 'active',
      }),
      task('b', 'idle', { lifecycle: 'active' }),
      task('c', 'idle', {
        projectKey: '/repos/model-routing',
        projectLabel: 'model-routing',
        lifecycle: 'active',
      }),
    ])
    expect(choices.map((choice) => choice.label)).toEqual(['model-routing', 'solus'])
    expect(choices.map((choice) => choice.count)).toEqual([2, 1])
  })

  it('counts only what the list will show, so the figure and the list agree', () => {
    // Snoozed and completed work lives on its own shelf below the list, so
    // counting it here would promise rows the filter does not produce.
    const choices = projectFilterChoices([
      task('a', 'idle', { lifecycle: 'active' }),
      task('b', 'idle', { lifecycle: 'snoozed' }),
      task('c', 'idle', { lifecycle: 'completed' }),
    ])
    expect(choices).toHaveLength(1)
    expect(choices[0].count).toBe(1)
  })
})

describe('hasGlyph', () => {
  it('spends a glyph only on states that want a person', () => {
    // Work in flight is not an alert: running reports elapsed time instead, and
    // idle reports nothing at all.
    expect(hasGlyph('question')).toBe(true)
    expect(hasGlyph('error')).toBe(true)
    expect(hasGlyph('running')).toBe(false)
    expect(hasGlyph('idle')).toBe(false)
  })
})

describe('showsUnreadIndicator', () => {
  it('shows completed unread session output independently of task lifecycle', () => {
    // WHY: a session can finish while its durable task remains in progress. The
    // only visible row for a task with one session must still report that output.
    expect(showsUnreadIndicator('idle', true)).toBe(true)
    expect(showsUnreadIndicator('running', true)).toBe(true)
    expect(showsUnreadIndicator('done', true)).toBe(true)
    expect(showsUnreadIndicator('idle', false)).toBe(false)
  })

  it('does not hide an active state that is explicitly waiting on the user', () => {
    expect(showsUnreadIndicator('question', true)).toBe(false)
    expect(showsUnreadIndicator('error', true)).toBe(false)
  })
})

describe('prChipFor', () => {
  it('matches a task to its PR on the head ref', () => {
    expect(prChipFor('run-host-selection', [pr()])).toEqual({
      number: 412,
      count: 1,
      state: 'open',
    })
  })

  it('renders nothing rather than a guess when no PR matches', () => {
    // The chip states standing information. An empty slot is honest; a chip
    // for someone else's branch is not.
    expect(prChipFor('run-host-selection', [])).toBeNull()
    expect(prChipFor('some-other-branch', [pr()])).toBeNull()
    expect(prChipFor(null, [pr()])).toBeNull()
  })

  it('reports merged, draft and approval-requested ahead of plain open', () => {
    expect(prChipFor('run-host-selection', [pr({ state: 'merged' })])?.state).toBe('merged')
    expect(prChipFor('run-host-selection', [pr({ draft: true })])?.state).toBe('draft')
    expect(prChipFor('run-host-selection', [pr({ needsMyReview: true })])?.state).toBe(
      'approvalRequested',
    )
  })
})

describe('prChipForBranches', () => {
  it('renders nothing until the exact linked PR resolves', () => {
    // WHY: a durable number provides navigation identity, not lifecycle state.
    // A chip appears only when its exact provider lookup returns the PR.
    expect(prChipForBranches([null, 'main'], [], 43)).toBeNull()
  })

  it('settles a linked PR when the provider reports it merged', () => {
    // WHY: a durable link starts as an open fallback, but provider state must
    // replace that fallback after a merge without requiring the PR page.
    expect(prChipForBranches(
      [null, 'main'],
      [pr({ number: 43, state: 'merged' })],
      43,
    )).toEqual({ number: 43, count: 1, state: 'merged' })
  })

  it('does not substitute a different branch match for the linked PR', () => {
    expect(prChipForBranches(
      ['solus/other-work'],
      [pr({ number: 44, headRef: 'solus/other-work' })],
      43,
    )).toBeNull()
  })

  it('matches a remote session worktree from attempt branches', () => {
    // WHY: a dispatched task is prepared on the task host before its execution
    // host resolves the worktree branch. Session attempts are authoritative
    // for branches and must still expose the GitHub PR in the sidebar.
    expect(prChipForBranches(
      ['solus/remote-worktree', 'main'],
      [pr({ number: 43, headRef: 'solus/remote-worktree' })],
    )).toEqual({ number: 43, count: 1, state: 'open' })
  })
})

describe('prChipForChoices', () => {
  const choice = (number: number, state: 'draft' | 'open' | 'approvalRequested' | 'closed' | 'merged') => ({
    number,
    targetScope: '/repo',
    title: `#${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    pullRequest: pr({
      number,
      state: state === 'merged' || state === 'closed' ? state : 'open',
      draft: state === 'draft',
      needsMyReview: state === 'approvalRequested',
    }),
  })

  it('counts every linked PR and gives review attention priority', () => {
    expect(prChipForChoices([
      choice(43, 'merged'),
      choice(44, 'approvalRequested'),
      choice(45, 'open'),
    ])).toEqual({ number: 43, count: 3, state: 'approvalRequested' })
  })

  it('still draws a pull request this client holds no record for', () => {
    // WHY: the record comes from the code host, and the link comes from our own
    // database. A host that is unreachable or unauthenticated must not empty the
    // column of pull requests the user can see are there — it may only leave
    // their state unknown, which reads as open.
    expect(prChipForChoices([{
      number: 65,
      targetScope: '/repo',
      title: '#65',
      url: null,
      pullRequest: null,
    }])).toEqual({ number: 65, count: 1, state: 'open' })
  })

  it('lets a known merge outrank an unknown neighbour', () => {
    expect(prChipForChoices([
      { number: 65, targetScope: '/repo', title: '#65', url: null, pullRequest: null },
      choice(66, 'merged'),
    ])?.state).toBe('open')
  })
})

describe('dedupePrChoices', () => {
  const linked = (number: number, url: string | null) => ({
    number,
    targetScope: '/repo',
    title: `linked #${number}`,
    url,
    pullRequest: null,
  })
  const observed = (number: number, url: string) => ({
    number,
    targetScope: '/repo',
    title: `observed #${number}`,
    url,
    pullRequest: pr({ number }),
  })

  it('names one pull request once when a link and a branch both point at it', () => {
    // WHY: the two sources overlap by design — a link is durable and a branch
    // observation is live — so the union has to collapse them or the row counts
    // one pull request twice.
    const choices = dedupePrChoices([
      linked(43, 'https://github.com/acme/app/pull/43'),
      observed(43, 'https://github.com/acme/app/pull/43'),
    ])
    expect(choices).toHaveLength(1)
    // The link was mentioned first, so its title stands; the observation still
    // contributes the live record the link had none of.
    expect(choices[0].title).toBe('linked #43')
    expect(choices[0].pullRequest?.number).toBe(43)
  })

  it('keeps one number in two repositories apart', () => {
    expect(dedupePrChoices([
      linked(43, 'https://github.com/acme/app/pull/43'),
      { ...linked(43, 'https://github.com/acme/other/pull/43'), targetScope: '/other' },
    ])).toHaveLength(2)
  })

  it('falls back to the owning project when no URL says which repository', () => {
    expect(dedupePrChoices([linked(43, null), linked(43, null)])).toHaveLength(1)
    expect(dedupePrChoices([
      linked(43, null),
      { ...linked(43, null), targetScope: '/other' },
    ])).toHaveLength(2)
  })

  it('takes a URL from whichever mention had one', () => {
    const [choice] = dedupePrChoices([linked(43, null), linked(43, null)])
    expect(choice.url).toBeNull()
    const [merged] = dedupePrChoices([
      linked(43, null),
      { ...linked(43, 'https://github.com/acme/app/pull/43'), targetScope: '/repo' },
    ])
    expect(merged.url).toBe('https://github.com/acme/app/pull/43')
  })
})

describe('taskStatusFor', () => {
  it('spends no glyph on a finished-but-unread session', () => {
    // The spec has no "finished" state and forbids unread badges; the signal
    // survives as a bolder title instead.
    expect(taskStatusFor('unread')).toBe('idle')
    expect(taskStatusFor(null)).toBe('idle')
  })

  it('maps every attention state that wants a person', () => {
    expect(taskStatusFor('awaiting')).toBe('question')
    expect(taskStatusFor('awaiting_plan')).toBe('plan')
    expect(taskStatusFor('error')).toBe('error')
    expect(taskStatusFor('queued')).toBe('limit')
    expect(taskStatusFor('running')).toBe('running')
  })

  it('lets the agent overrule a stale tick', () => {
    // Done is the user's verdict on a task at rest. The moment that task wants
    // something or starts working again, the check they ticked is out of date
    // and the sidebar has to report what is actually happening.
    expect(taskStatusFor(null, true)).toBe('done')
    expect(taskStatusFor('unread', true)).toBe('done')
    expect(taskStatusFor('running', true)).toBe('running')
    expect(taskStatusFor('awaiting', true)).toBe('question')
  })
})

describe('task attention aggregation', () => {
  it('keeps a failed turn on its session instead of marking the task as failed', () => {
    // WHY: a task can have several attempts. One failed provider resume does
    // not mean that the durable task itself failed.
    expect(maxTaskAttention(null, 'error')).toBeNull()
    expect(maxTaskAttention('running', 'error')).toBe('running')
  })

  it('still raises attention that applies to the whole task row', () => {
    expect(maxTaskAttention(null, 'running')).toBe('running')
    expect(maxTaskAttention('running', 'awaiting')).toBe('awaiting')
  })
})

describe('title emphasis', () => {
  it('leaves unread output to the margin instead of the title weight', () => {
    // Unread used to bold the title, which put it in the same channel as
    // selection and as the states that are actually blocked on a person — so a
    // heavier row meant three unrelated things and ranked none of them. The
    // margin dot carries unread now, and weight is back to one meaning per row.
    expect(hasGlyph('idle')).toBe(false)
    expect(shouldEmphasizeTitle('idle', true, false)).toBe(false)
  })

  it('still lifts unread out of the mutedness, on ink rather than weight', () => {
    // The rule above holds for *weight*, but the column now mutes every row it
    // is not showing, and the margin dot was calibrated against titles that all
    // sat at full ink. Unread has to survive that falloff or the one state that
    // exists to be noticed becomes the easiest to miss.
    expect(shouldLeadTitle('idle', true, false)).toBe(true)
    expect(shouldLeadTitle('idle', false, false)).toBe(false)
  })

  it('does not re-lift an error the user has already read', () => {
    // Its glyph is durable status the margin keeps stating. Lifting the row
    // again after it was looked at leaves no way to clear the column.
    expect(shouldLeadTitle('error', false, false)).toBe(false)
    expect(shouldLeadTitle('error', true, false)).toBe(true)
  })

  it('stops emphasizing an error after the user reads it', () => {
    // WHY: the error glyph must remain as durable status, but bold text is the
    // call to inspect new activity. The selection spine locates the row while
    // it is open, so a read error does not need a second selection signal.
    expect(shouldEmphasizeTitle('error', true, false)).toBe(true)
    expect(shouldEmphasizeTitle('error', false, true)).toBe(false)
    expect(shouldEmphasizeTitle('error', false, false)).toBe(false)
  })

  it('still emphasizes selection and unresolved requests', () => {
    expect(shouldEmphasizeTitle('idle', false, true)).toBe(true)
    expect(shouldEmphasizeTitle('question', false, false)).toBe(true)
    expect(shouldEmphasizeTitle('plan', false, false)).toBe(true)
    expect(shouldEmphasizeTitle('limit', false, false)).toBe(true)
  })
})

describe('hasDisclosure', () => {
  it('opens a task whose only session belongs to a subtask', () => {
    // The row is named after the root task, so without the disclosure the
    // subtask has no representation in the column at all — the reason a task
    // having subtasks was invisible in the first place.
    expect(hasDisclosure([{ isSubtask: true }])).toBe(true)
  })

  it('stays flat for a task that is already its one session', () => {
    // Nothing to reveal: expanding would restate the row underneath itself.
    expect(hasDisclosure([{ isSubtask: false }])).toBe(false)
    expect(hasDisclosure([])).toBe(false)
  })

  it('opens any task holding more than one session', () => {
    expect(hasDisclosure([{}, {}])).toBe(true)
  })
})

describe('taskRowBranchName', () => {
  it('states the lone session branch a durable task row does not carry', () => {
    // A durable row has no branch of its own, and its one plain session never
    // gets a row — so without this the worktree is nowhere in the column.
    expect(taskRowBranchName(null, [{ branchName: 'solus/refine-sidebar' }]))
      .toBe('solus/refine-sidebar')
  })

  it('leaves the branch to the child rows once the task discloses', () => {
    // Each disclosed session answers for itself; one branch on the parent
    // would claim to speak for work sitting on another.
    expect(taskRowBranchName(null, [
      { branchName: 'solus/one' },
      { branchName: 'solus/two' },
    ])).toBe(null)
    expect(taskRowBranchName(null, [{ branchName: 'solus/one', isSubtask: true }])).toBe(null)
  })

  it('keeps a loose row on its own branch when no session names one', () => {
    expect(taskRowBranchName('main', [{ branchName: null }])).toBe('main')
    expect(taskRowBranchName('main', [])).toBe('main')
  })
})

describe('sidebarChildLabel', () => {
  it('names a subtask row after the subtask instead of its provider session', () => {
    expect(sidebarChildLabel(
      durableTask('in_progress', { title: 'Verify the release', parentId: 'parent' }),
      'Session Task Sidebar',
    )).toBe('Verify the release')
  })

  it('keeps root-task attempts distinguishable by session name', () => {
    expect(sidebarChildLabel(
      durableTask('in_progress', { title: 'Ship the release' }),
      'Second attempt',
    )).toBe('Second attempt')
  })
})

describe('worktreeDisplayName', () => {
  it('drops the namespace every Solus worktree shares, since it distinguishes none of them', () => {
    expect(worktreeDisplayName('solus/mcp-discovery-modes-a1b2c')).toBe('mcp-discovery-modes-a1b2c')
  })

  it('keeps a branch the user named, including one that merely contains the namespace', () => {
    expect(worktreeDisplayName('main')).toBe('main')
    expect(worktreeDisplayName('feature/solus/rework')).toBe('feature/solus/rework')
  })

  it('never renders an empty row: a bare namespace is left as it is', () => {
    expect(worktreeDisplayName('solus/')).toBe('solus/')
  })
})

describe('open sessions the picker offers', () => {
  const lookupOf = (byId: Record<string, Task>) => ({
    taskForSession: (sessionId: string | null | undefined) =>
      (sessionId ? byId[sessionId] : null) ?? null,
  })
  const taskWith = (status: Task['status']): Task => ({ status } as Task)

  it('drops a session whose task the user finished, matching the Completed shelf', () => {
    // WHY: the picker's "Open" section and the sidebar list the same work. A
    // done task leaves the sidebar list, so its mounted tab must stop counting
    // as an open session, or the picker reports sessions the sidebar denies.
    const lookup = lookupOf({ 'agent-1': taskWith('done') })
    expect(isCompletedTaskSession({ id: 'sess-1', agentSessionId: 'agent-1' }, lookup)).toBe(true)
  })

  it('keeps a snoozed or unfinished session, and one with no task at all', () => {
    // Snooze defers work rather than ending it, and a session that predates
    // task minting has nothing to be finished by.
    expect(isCompletedTaskSession(
      { id: 'sess-1', agentSessionId: 'agent-1' },
      lookupOf({ 'agent-1': taskWith('in_progress') }),
    )).toBe(false)
    expect(isCompletedTaskSession(
      { id: 'sess-1', agentSessionId: null },
      lookupOf({}),
    )).toBe(false)
  })

  it('reads the handoff chain\'s task, not the replaced session\'s', () => {
    // A handed-off session keeps its own id; the task follows the chain.
    const lookup = lookupOf({ 'handoff-1': taskWith('done'), 'sess-1': taskWith('in_progress') })
    expect(isCompletedTaskSession(
      { id: 'sess-1', agentSessionId: null, handoffId: 'handoff-1' },
      lookup,
    )).toBe(true)
  })
})

describe('done rows', () => {
  it('spends no glyph, so the row falls back to standing information', () => {
    // Completed is the quietest row in the column: it has nothing to ask for.
    expect(hasGlyph('done')).toBe(false)
  })
})

describe('review guide status', () => {
  it('summarizes child guide work on the task and clears when every mark is read', () => {
    expect(aggregateReviewGuideStatus([
      { reviewGuideStatus: 'ready' },
      { reviewGuideStatus: 'generating' },
    ])).toBe('generating')
    expect(aggregateReviewGuideStatus([
      { reviewGuideStatus: null },
      { reviewGuideStatus: 'ready' },
    ])).toBe('ready')
    expect(aggregateReviewGuideStatus([
      { reviewGuideStatus: null },
      { reviewGuideStatus: null },
    ])).toBeNull()
  })
})

describe('formatElapsed', () => {
  it('spends seconds only while they are the whole answer', () => {
    // Past the first minute the row is answering "still going, roughly how
    // long", which the minute alone answers — and the four characters the
    // seconds cost come straight out of the title beside them.
    expect(formatElapsed(41_000)).toBe('41s')
    expect(formatElapsed(61_000)).toBe('1m')
    expect(formatElapsed(70_000)).toBe('1m')
    expect(formatElapsed(12 * 60_000 + 7_000)).toBe('12m')
  })

  it('holds its width as the hour readout ticks past a single digit', () => {
    // The hour form keeps its minutes, because 1h to 2h is an hour of silence.
    // It updates in the corner of the user's eye, so the string has to stay the
    // same length — a row that widens once a minute reads as movement.
    expect(formatElapsed(3_601_000)).toBe('1h 00m')
    expect(formatElapsed(3_660_000)).toBe('1h 01m')
    expect(formatElapsed(3_601_000)).toHaveLength(formatElapsed(4_200_000).length)
  })

  it('never reports a negative run for a clock that drifted backwards', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})

describe('formatWakeIn', () => {
  const now = Date.parse('2026-03-01T12:00:00Z')

  it('reports when a snoozed row comes back, as a duration', () => {
    // A sidebar that states every other time as an elapsed duration must not
    // state this one as a clock time: two scales in one column means neither
    // can be read at a glance.
    expect(formatWakeIn(now + 20 * 60_000, now)).toBe('20m')
    expect(formatWakeIn(now + 3 * 3_600_000, now)).toBe('3h')
    expect(formatWakeIn(now + 2 * 86_400_000, now)).toBe('2d')
  })

  it('never reads zero while the row is still hidden', () => {
    // Rounding down would let a row that is demonstrably still asleep claim it
    // has already woken.
    expect(formatWakeIn(now + 10_000, now)).toBe('1m')
    expect(formatWakeIn(now + 61 * 60_000, now)).toBe('2h')
  })

  it('says now once the wake time has passed', () => {
    expect(formatWakeIn(now, now)).toBe('now')
    expect(formatWakeIn(now - 60_000, now)).toBe('now')
  })
})

describe('resolveSidebarRowMark', () => {
  const base = {
    status: 'idle' as const,
    unread: false,
    woke: false,
    reviewGuide: null,
    lifecycle: 'active' as const,
    runStartedAt: 0,
    manyRunning: false,
    completedAt: 0,
    snoozedUntil: 0,
    now: 1_000_000,
  }

  it('spends one mark even when every state is true at once', () => {
    // This is the whole rule. A row could once show a guide glyph, an alarm, a
    // wake time and a clock in the same right edge, so four marks competed for
    // one glance and the row answered no question quickly.
    const mark = resolveSidebarRowMark({
      ...base,
      status: 'question',
      unread: true,
      woke: true,
      reviewGuide: 'ready',
      runStartedAt: base.now - 5_000,
    })
    expect(mark).toEqual({ kind: 'glyph', status: 'question' })
  })

  it('ranks a request for a person above every report of progress', () => {
    expect(resolveSidebarRowMark({ ...base, status: 'error', unread: true }))
      .toEqual({ kind: 'glyph', status: 'error' })
    expect(resolveSidebarRowMark({ ...base, status: 'plan', reviewGuide: 'ready' }))
      .toEqual({ kind: 'glyph', status: 'plan' })
  })

  it('ranks a lapsed snooze above unread output', () => {
    // The column promised to bring the row back. Output the user was never told
    // to expect can wait behind a promise the column made.
    expect(resolveSidebarRowMark({ ...base, woke: true, unread: true }))
      .toEqual({ kind: 'woke' })
  })

  it('ranks unread output above a run still in flight', () => {
    expect(
      resolveSidebarRowMark({
        ...base,
        status: 'running',
        unread: true,
        runStartedAt: base.now - 5_000,
      }),
    ).toEqual({ kind: 'unread' })
  })

  it('dates the turn when there is exactly one to date', () => {
    expect(
      resolveSidebarRowMark({ ...base, status: 'running', runStartedAt: base.now - 41_000 }),
    ).toEqual({ kind: 'elapsed', label: '41s' })
  })

  it('shows motion instead of a number when no single turn can be dated', () => {
    // Several sessions running at once have no shared clock, and a reconnect
    // with no reliable start time has none at all.
    expect(
      resolveSidebarRowMark({
        ...base,
        status: 'running',
        runStartedAt: base.now - 41_000,
        manyRunning: true,
      }),
    ).toEqual({ kind: 'spinner' })
    expect(resolveSidebarRowMark({ ...base, status: 'running', runStartedAt: 0 }))
      .toEqual({ kind: 'spinner' })
  })

  it('lets a live turn outrank a guide still being written', () => {
    expect(
      resolveSidebarRowMark({
        ...base,
        status: 'running',
        runStartedAt: base.now - 5_000,
        reviewGuide: 'generating',
      }),
    ).toEqual({ kind: 'elapsed', label: '5s' })
    expect(resolveSidebarRowMark({ ...base, reviewGuide: 'generating' }))
      .toEqual({ kind: 'guide', state: 'generating' })
  })

  it('gives each shelf its own clock, and only when the row is on it', () => {
    expect(
      resolveSidebarRowMark({
        ...base,
        lifecycle: 'snoozed',
        snoozedUntil: base.now + 3 * 3_600_000,
      }),
    ).toEqual({ kind: 'wake', label: '3h' })
    expect(
      resolveSidebarRowMark({
        ...base,
        lifecycle: 'completed',
        completedAt: base.now - 6 * 3_600_000,
      }),
    ).toEqual({ kind: 'age', label: '6h' })
  })

  it('says nothing at all about a quiet active row', () => {
    // An empty slot is the point: a row with nothing to report must not invent
    // something so the column looks uniform.
    expect(resolveSidebarRowMark(base)).toBeNull()
  })
})

describe('shouldRecedeRow', () => {
  it('steps back quiet work so the loud rows are the ones the eye lands on', () => {
    expect(shouldRecedeRow('idle', false, false, false)).toBe(true)
    expect(shouldRecedeRow('running', false, false, false)).toBe(true)
    expect(shouldRecedeRow('done', false, false, false)).toBe(true)
  })

  it('never recedes a row that wants a person', () => {
    // Recession is how the column ranks itself now, so anything asking a
    // question, holding unread output, or returning from a snooze has to be
    // exempt — otherwise the states that need a human are the ones that fade.
    expect(shouldRecedeRow('question', false, false, false)).toBe(false)
    expect(shouldRecedeRow('error', false, false, false)).toBe(false)
    expect(shouldRecedeRow('idle', true, false, false)).toBe(false)
    expect(shouldRecedeRow('idle', false, true, false)).toBe(false)
  })

  it('never recedes the row you are reading', () => {
    expect(shouldRecedeRow('idle', false, false, true)).toBe(false)
    expect(shouldRecedeRow('running', false, false, true)).toBe(false)
  })
})
