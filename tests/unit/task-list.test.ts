import { describe, expect, it } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import {
  buildProjectSummaries,
  formatElapsed,
  groupTasks,
  prChipFor,
  projectInitial,
  reconcileSidebarTasks,
  showsProjectLine,
  sortTasks,
  taskStatusFor,
  trailingSlot,
  type SidebarTask,
  type TaskStatus,
} from '../../src/renderer/components/session/lib/task-list'

function task(
  key: string,
  status: TaskStatus,
  overrides: Partial<SidebarTask> = {},
): SidebarTask {
  return {
    key,
    title: key,
    projectKey: '/repos/solus',
    projectLabel: 'solus',
    branchName: key,
    status,
    attention: null,
    unread: false,
    activityAt: 0,
    runStartedAt: 0,
    tabIds: [key],
    ...overrides,
  }
}

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
    const previousByKey = new Map([
      [first.key, first],
      [second.key, second],
    ])

    const reconciled = reconcileSidebarTasks(previousByKey, [
      task('first', 'idle', { unread: false }),
      task('second', 'running'),
    ])

    expect(reconciled[0]).not.toBe(first)
    expect(reconciled[1]).toBe(second)
  })

  it('drops closed task models from the identity cache', () => {
    const first = task('first', 'idle')
    const second = task('second', 'idle')
    const previousByKey = new Map([
      [first.key, first],
      [second.key, second],
    ])

    reconcileSidebarTasks(previousByKey, [task('second', 'idle')])

    expect([...previousByKey.keys()]).toEqual(['second'])
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
  it('drops the project line whenever the container already states it', () => {
    // Never repeat the container: filtered to one project, or grouped under a
    // project heading, the line is noise.
    expect(showsProjectLine('flat', null, 2)).toBe(true)
    expect(showsProjectLine('flat', '/repos/solus', 2)).toBe(false)
    expect(showsProjectLine('grouped', null, 2)).toBe(false)
    expect(showsProjectLine('flat', null, 1)).toBe(false)
  })
})

describe('trailingSlot', () => {
  it('keeps reporting status while the pointer is on the row', () => {
    // Hover used to swap the margin out for a toolbar, which meant the one row
    // you were reaching for was the one row that stopped reporting.
    expect(trailingSlot('question', true, false)).toBe('status')
    expect(trailingSlot('question', true, true)).toBe('status')
  })

  it('resolves the rest of the precedence: PR chip, then empty', () => {
    expect(trailingSlot('idle', true, false)).toBe('pr')
    expect(trailingSlot('idle', false, false)).toBe('none')
  })

  it('reports a running task as elapsed time rather than a glyph', () => {
    // Work in flight is not an alert, so running spends a number instead of a
    // glyph — but it is still something happening now, so it outranks the PR
    // chip, which is only standing information.
    expect(trailingSlot('running', false, false)).toBe('elapsed')
    expect(trailingSlot('running', true, false)).toBe('elapsed')
    expect(trailingSlot('running', true, true)).toBe('elapsed')
  })

  it('yields only the PR chip to the hover actions', () => {
    // Standing information, and the widest thing in the margin — it is the one
    // occupant that can afford to step aside for the buttons.
    expect(trailingSlot('idle', true, true)).toBe('none')
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

describe('done rows', () => {
  it('spends no glyph and keeps its PR chip', () => {
    // Completed is the quietest row in the column: it has nothing to ask for,
    // so the trailing slot falls back to the standing information.
    expect(trailingSlot('done', true, false)).toBe('pr')
    expect(trailingSlot('done', false, false)).toBe('none')
    expect(trailingSlot('done', true, true)).toBe('none')
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
