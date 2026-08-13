import { describe, expect, it } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import type { Task } from '../../src/shared/task-types'
import {
  aggregateReviewGuideStatus,
  belongsToSelectedHost,
  buildProjectSummaries,
  formatCompletedAge,
  formatElapsed,
  filterSidebarTasks,
  groupTasks,
  hasDisclosure,
  sidebarChildLabel,
  hasGlyph,
  prChipFor,
  prChipForBranches,
  projectInitial,
  reconcileSidebarTasks,
  resolveTaskSidebarLifecycle,
  shouldCompleteTaskForPr,
  shouldShowDurableSidebarTask,
  showsUnreadIndicator,
  projectFilterChoices,
  resolveProjectFilter,
  sortTasks,
  taskStatusFor,
  type SidebarTask,
  type TaskStatus,
} from '../../src/renderer/components/session/lib/task-list'

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

describe('sidebar host scope', () => {
  it('shows only work owned by the selected host', () => {
    expect(belongsToSelectedHost('remote', 'remote')).toBe(true)
    expect(belongsToSelectedHost('local', 'remote')).toBe(false)
  })

  it('keeps provisional work visible until its host ownership is known', () => {
    expect(belongsToSelectedHost(null, 'remote')).toBe(true)
  })
})

describe('completed task age', () => {
  const now = Date.parse('2026-08-11T12:00:00Z')

  it('keeps the completed shelf age compact from minutes through days', () => {
    // WHY: completed rows have one narrow trailing column and must not grow
    // into prose or switch to an unrelated calendar-date representation.
    expect(formatCompletedAge(now - 57 * 60_000, now)).toBe('57m')
    expect(formatCompletedAge(now - 6 * 3_600_000, now)).toBe('6h')
    expect(formatCompletedAge(now - 38 * 86_400_000, now)).toBe('38d')
  })
})

describe('sidebar lifecycle resolution', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  it('keeps inactive work active until its task status changes', () => {
    expect(resolveTaskSidebarLifecycle({ task: { status: 'in_progress' }, now }).lifecycle).toBe('active')
  })

  it('puts done tasks in Completed ahead of stale snooze metadata', () => {
    expect(resolveTaskSidebarLifecycle({
      task: { status: 'done', doneAt: now - 1, snoozedUntil: now + 1 },
      now,
    })).toMatchObject({ lifecycle: 'completed', completedAt: now - 1 })
  })

  it('returns an expired snooze with a woke marker until it is read', () => {
    expect(resolveTaskSidebarLifecycle({
      task: { status: 'in_progress', snoozedUntil: now - 1, lastReadAt: 0 },
      now,
    })).toMatchObject({ lifecycle: 'active', woke: true })
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
    expect(shouldShowDurableSidebarTask(durableTask('done'), false, false)).toBe(true)
    expect(shouldShowDurableSidebarTask(durableTask('dropped'), false, false)).toBe(true)
  })

  it('restores a completed task when one of its sessions is reopened', () => {
    // WHY: completion removes the row by dismissing it, so reopening a session
    // has to bring the task back. Hiding a finished task on status instead left
    // the reopened conversation mounted with no row — and unloaded again.
    expect(shouldShowDurableSidebarTask(durableTask('done'), true, true)).toBe(true)
  })

  it('restores an open task when a new session explicitly reopens it', () => {
    const task = durableTask('in_progress')
    expect(shouldShowDurableSidebarTask(task, true, false)).toBe(false)
    expect(shouldShowDurableSidebarTask(task, true, true)).toBe(true)
  })

  it('continues to project child tasks through their root row', () => {
    expect(
      shouldShowDurableSidebarTask(durableTask('in_progress', { parentId: 'root' }), false, true),
    ).toBe(false)
  })
})

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 412,
    title: 'Run host selection',
    headSha: 'abc',
    author: 'ashton',
    authorAvatarUrl: '',
    state: 'open',
    createdAt: '',
    updatedAt: '',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    headRef: 'run-host-selection',
    ...overrides,
  }
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
    expect(solus).toMatchObject({ label: 'solus', initial: 'S', count: 2, waiting: 1, failed: 0 })
    expect(routing).toMatchObject({ label: 'model-routing', initial: 'MR', count: 1, waiting: 0, failed: 1 })
  })

  it('leads each project with its most urgent task, so picking one lands on the decision', () => {
    // The picker exists to move you somewhere useful. Landing on whatever task
    // happens to be first in tab order would make it a navigation dead end.
    const [summary] = buildProjectSummaries([task('idle', 'idle'), task('asks', 'question')])
    expect(summary.leadTaskKey).toBe('asks')
  })
})

describe('projectInitial', () => {
  it('takes one letter from a single word and two from a compound name', () => {
    expect(projectInitial('solus')).toBe('S')
    expect(projectInitial('model-routing')).toBe('MR')
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
  it('renders the task linked PR without branch or list discovery', () => {
    // WHY: the durable task link is the source of truth. It can arrive from a
    // remote attempt before this client has loaded that repository's PR list.
    expect(prChipForBranches([null, 'main'], [], 43)).toEqual({
      number: 43,
      state: 'open',
    })
  })

  it('settles a linked PR when the provider reports it merged', () => {
    // WHY: a durable link starts as an open fallback, but provider state must
    // replace that fallback after a merge without requiring the PR page.
    expect(prChipForBranches(
      [null, 'main'],
      [pr({ number: 43, state: 'merged' })],
      43,
    )).toEqual({ number: 43, state: 'merged' })
  })

  it('keeps the linked PR when a branch matches a different list item', () => {
    expect(prChipForBranches(
      ['solus/other-work'],
      [pr({ number: 44, headRef: 'solus/other-work' })],
      43,
    )).toEqual({ number: 43, state: 'open' })
  })

  it('matches a remote session worktree when the task still records its local branch', () => {
    // WHY: a dispatched task is prepared on the task host before its execution
    // host resolves the worktree branch. The mounted session is authoritative
    // for that attempt and must still expose its GitHub PR in the sidebar.
    expect(prChipForBranches(
      ['solus/remote-worktree', 'main'],
      [pr({ number: 43, headRef: 'solus/remote-worktree' })],
    )).toEqual({ number: 43, state: 'open' })
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

describe('title emphasis', () => {
  it('leaves unread output to the margin instead of the title weight', () => {
    // Unread used to bold the title, which put it in the same channel as
    // selection and as the states that are actually blocked on a person — so a
    // heavier row meant three unrelated things and ranked none of them. The
    // margin dot carries unread now, and weight is back to one meaning per row.
    expect(hasGlyph('idle')).toBe(false)
  })

  it('still emphasizes every state that is waiting on a person', () => {
    expect(hasGlyph('question')).toBe(true)
    expect(hasGlyph('plan')).toBe(true)
    expect(hasGlyph('limit')).toBe(true)
    expect(hasGlyph('error')).toBe(true)
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
  it('holds its width as the clock ticks past a single digit', () => {
    // The readout updates every second in the corner of the user's eye. Tabular
    // figures stop the digits shifting, but only padding stops the string
    // getting longer — and a row that widens once a minute reads as movement.
    expect(formatElapsed(61_000)).toBe('1m 01s')
    expect(formatElapsed(69_000)).toBe('1m 09s')
    expect(formatElapsed(70_000)).toBe('1m 10s')
    expect(formatElapsed(61_000)).toHaveLength(formatElapsed(70_000).length)
    expect(formatElapsed(3_601_000)).toHaveLength(formatElapsed(3_660_000).length)
  })

  it('drops a unit rather than printing a figure nobody reads', () => {
    // Under a minute there is no minutes column to pad against, and past an
    // hour the seconds stop being information.
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(9_000)).toBe('9s')
    expect(formatElapsed(3_660_000)).toBe('1h 01m')
  })

  it('never reports a negative run for a clock that drifted backwards', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})
