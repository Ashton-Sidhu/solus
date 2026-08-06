import { describe, expect, it } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import type { Task } from '../../src/shared/task-types'
import {
  aggregateReviewGuideStatus,
  buildProjectSummaries,
  formatElapsed,
  groupTasks,
  hasDisclosure,
  sidebarChildLabel,
  hasGlyph,
  prChipFor,
  projectInitial,
  reconcileSidebarTasks,
  shouldShowDurableSidebarTask,
  showsUnreadIndicator,
  showsProjectLine,
  sortTasks,
  taskStatusFor,
  type SidebarTask,
  type TaskStatus,
} from '../../src/renderer/components/session/lib/task-list'

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

describe('showsProjectLine', () => {
  it('drops the project line only where the container already states it', () => {
    // Never repeat the container: grouped under a project heading, the line is
    // noise. A flat list has no heading, so the row has to say it itself —
    // including while only one project happens to be open, so the column does
    // not silently change shape the moment a second one appears.
    expect(showsProjectLine('flat')).toBe(true)
    expect(showsProjectLine('grouped')).toBe(false)
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
  it('shows unread ahead of a running task, then reveals running once read', () => {
    // A task can aggregate an unread reply from one session and a live run from
    // another. The unread reply needs attention first; clearing it must expose
    // the run that never stopped underneath it.
    expect(showsUnreadIndicator('running', true)).toBe(true)
    expect(showsUnreadIndicator('running', false)).toBe(false)
  })

  it('does not hide a state that is explicitly waiting on the user', () => {
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
