import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'
import { buildBoard, NO_COLUMN_ID, type BoardView } from '@solus/workspace-ui/components/tasks/lib/tasks-api'
import {
  isDone,
  isOpenColumnFilter,
  isTaskSnoozed,
  nextTaskWake,
  openColumnIds,
  taskBoardCard,
  taskGroups,
  taskRow,
} from '@solus/workspace-ui/components/tasks/lib/tasks-list-view'

const NOW = Date.parse('2026-08-04T13:00:00Z')
const BOARD = 'github-project:acme/7'

function issue(number: number, category: TaskStatusCategory = 'open', overrides: Partial<Task> = {}): Task {
  return {
    id: `github:I_${number}`,
    providerId: 'github',
    kind: 'issue',
    reference: `acme/app#${number}`,
    title: `Issue ${number}`,
    body: '',
    url: `https://github.com/acme/app/issues/${number}`,
    state: category === 'done' ? { name: 'Closed', category: 'done' } : { name: 'Open', category: 'open' },
    category,
    placements: [{ sourceKey: 'github-repo:acme/app', columnId: category === 'done' ? 'closed' : 'open' }],
    labels: [],
    writableFields: ['title', 'body', 'labels', 'assignee'],
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  }
}

function draft(id: string, columnId: string | null): Task {
  return issue(0, 'open', {
    id: `github:${id}`,
    kind: 'draft',
    reference: undefined,
    url: null,
    title: `Draft ${id}`,
    state: { name: 'Todo', category: 'open' },
    placements: [{ sourceKey: BOARD, columnId }],
  })
}

function jiraIssue(key: string): Task {
  return issue(0, 'active', {
    id: 'jira:cloud-1:10128',
    providerId: 'jira',
    reference: key,
    state: { name: 'In Progress', category: 'active' },
    placements: [{ sourceKey: 'jira-project:cloud-1/ACME', columnId: '3' }],
  })
}

const boardView: BoardView = {
  kind: 'source',
  source: {
    sourceKey: BOARD,
    columns: [
      { id: 'opt-todo', name: 'Backlog', category: 'open' },
      { id: 'opt-doing', name: 'Building', category: 'active' },
      { id: 'opt-done', name: 'Shipped', category: 'done' },
      { id: 'opt-wontfix', name: 'Not planned', category: 'done' },
    ],
  },
}

const noSessions = () => 0

describe('the column filter a list opens on', () => {
  test('opens on the columns of work that is not done, in a source view and in the mixed view', () => {
    // WHY: a list that leads with everything ever closed buries the handful of
    // things still moving. A provider can have more than one done column, and
    // the names are the provider's, so the rule reads the status category.
    expect(openColumnIds(buildBoard([], boardView))).toEqual(['opt-todo', 'opt-doing'])
    expect(openColumnIds(buildBoard([], { kind: 'all' }))).toEqual(['open', 'active'])
  })

  test('board items with no column are open work, so the list shows them', () => {
    // WHY: a new GitHub Project item has no Status. Hiding it by default would
    // hide exactly the newest work.
    const columns = buildBoard([draft('DI_1', null)], boardView)
    expect(openColumnIds(columns)).toEqual([NO_COLUMN_ID, 'opt-todo', 'opt-doing'])
  })

  test('the filter a list opens on is not counted as a filter', () => {
    // WHY: the Filters badge and its Clear filters item mean "you narrowed
    // this". Clearing puts the filter back to open work, so open work in any
    // order must read as unfiltered, or the badge would survive the clear.
    const columns = buildBoard([], boardView)
    expect(isOpenColumnFilter(columns, ['opt-doing', 'opt-todo'])).toBe(true)
    expect(isOpenColumnFilter(columns, ['opt-todo', 'opt-doing', 'opt-done'])).toBe(false)
    expect(isOpenColumnFilter(columns, ['opt-todo'])).toBe(false)
    expect(isOpenColumnFilter(columns, columns.map((column) => column.id))).toBe(false)
  })

  test('done is the status category, whatever the provider calls the state', () => {
    expect(isDone({ category: 'done' })).toBe(true)
    expect(isDone({ category: 'active' })).toBe(false)
  })
})

describe('the grouped list', () => {
  test('has one section for each column of the view that has a task, in the order of the view', () => {
    // WHY: the list and the board group the same way, so a task is under the
    // same heading in both layouts. Empty sections are noise in a list.
    const tasks = [
      { ...draft('DI_done', 'opt-done') },
      { ...draft('DI_todo', 'opt-todo') },
      { ...draft('DI_new', null) },
    ]
    const groups = taskGroups(buildBoard(tasks, boardView), noSessions, NOW)

    expect(groups.map((group) => group.label)).toEqual(['No column', 'Backlog', 'Shipped'])
    expect(groups.map((group) => group.key)).toEqual([NO_COLUMN_ID, 'opt-todo', 'opt-done'])
    expect(groups[1].rows.map((row) => row.key)).toEqual(['github:DI_todo'])
  })

  test('the mixed view groups by status category', () => {
    const groups = taskGroups(buildBoard([issue(2, 'done'), issue(1, 'open')], { kind: 'all' }), noSessions, NOW)
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.ident)])).toEqual([
      ['Open', ['#1']],
      ['Done', ['#2']],
    ])
  })

  test('each row gets the count of sessions that run on its own task', () => {
    // WHY: the "agent" line says that work happens now on this task.
    const groups = taskGroups(buildBoard([issue(1), issue(2)], { kind: 'all' }), (taskId) => (taskId === 'github:I_2' ? 2 : 0), NOW)
    expect(groups[0].rows.map((row) => row.meta)).toEqual(['', 'agent · 2 sessions'])
  })
})

describe('where a task row says it lives', () => {
  test('project and host take the place column, not a chip after the title', () => {
    // WHY: the list is a table. A project chip trailing each title sat at a
    // different x on every row and could not be scanned down; a column can.
    const placeFor = () => ({ project: 'acme/app', host: 'Solus Cloud' })
    const row = taskRow(issue(1, 'open', { labels: ['design'] }), 0, NOW, placeFor)
    expect(row.place).toEqual({ project: 'acme/app', host: 'Solus Cloud' })
    expect(row.chips.map((chip) => chip.label)).toEqual(['design'])
  })

  test('a page that draws no place column gives no row the cell', () => {
    // WHY: every row of one list must agree on the column, or the cells drift.
    const groups = taskGroups(buildBoard([issue(1), issue(2)], { kind: 'all' }), noSessions, NOW, () => undefined)
    expect(groups[0].rows.every((row) => row.place === undefined)).toBe(true)
  })

  test('a board card names the host as a chip, because a card has no place column', () => {
    const card = taskBoardCard(issue(1, 'open', { labels: ['design'] }), 0, NOW, () => 'Solus Cloud')
    expect(card.chips.map((chip) => chip.label)).toEqual(['Solus Cloud', 'design'])
  })
})

describe('how a row names its task', () => {
  test('a GitHub issue shows its number, and the provider mark names the whole reference', () => {
    // WHY: GitHub and Jira own every task. The row names the task as the
    // provider does, so a person can find it there; the cell is narrow, so the
    // repository is in the mark's title.
    const row = taskRow(issue(412), 0, NOW)
    expect(row.key).toBe('github:I_412')
    expect(row.ident).toBe('#412')
    expect(row.source).toEqual({ id: 'github', title: 'GitHub · acme/app#412' })
  })

  test('a Jira issue shows its key, and the mark names Jira', () => {
    // WHY: the tooltip said "GitHub" for every provider, so a Jira row claimed
    // to be a GitHub issue.
    const row = taskRow(jiraIssue('ACME-128'), 0, NOW)
    expect(row.ident).toBe('ACME-128')
    expect(row.source).toEqual({ id: 'jira', title: 'Jira · ACME-128' })
  })

  test('a draft item has no reference: the row says Draft and the mark says what it is', () => {
    // WHY: a draft of a GitHub Project is not an issue yet. A blank identifier
    // cell would read as a broken row.
    const row = taskRow(draft('DI_1', 'opt-todo'), 0, NOW)
    expect(row.ident).toBe('Draft')
    expect(row.source).toEqual({ id: 'github', title: 'GitHub · draft item' })
  })
})

describe('the one line of machine state', () => {
  test('a running agent outranks the pull request, and finished work says that it is closed', () => {
    // WHY: on the board this sentence is the whole middle line of the card.
    // Open work with nothing to report stays silent.
    const pr = { number: 5, url: 'https://github.com/acme/app/pull/5' }
    expect(taskRow(issue(1), 0, NOW).meta).toBe('')
    expect(taskRow(issue(1, 'open', { pr }), 0, NOW).meta).toBe('PR #5')
    expect(taskRow(issue(1, 'open', { pr }), 1, NOW).meta).toBe('agent · 1 session')
    expect(taskRow(issue(1, 'done', { pr }), 0, NOW).meta).toBe('closed · #5')
    expect(taskRow(issue(1, 'done'), 0, NOW).meta).toBe('closed')
  })
})

describe('a board card', () => {
  test('carries its own status mark and steps back when the task is done', () => {
    // WHY: a card travels under the cursor in a drag, away from the column
    // head, so the column cannot say its status for it. Done work is history.
    const open = taskBoardCard(draft('DI_1', 'opt-todo'), 0, NOW)
    expect(open).toMatchObject({ key: 'github:DI_1', ident: 'Draft', category: 'open', dimmed: false, live: false, status: '' })

    const done = taskBoardCard(issue(7, 'done'), 0, NOW)
    expect(done).toMatchObject({ ident: '#7', category: 'done', dimmed: true, status: 'closed' })
  })

  test('is live only while an agent runs on the task', () => {
    const card = taskBoardCard(issue(7, 'active'), 2, NOW)
    expect(card.live).toBe(true)
    expect(card.status).toBe('agent · 2 sessions')
  })

  test('shows the assignee the provider reports', () => {
    const card = taskBoardCard(issue(7, 'open', { assignee: 'octocat', assigneeAvatarUrl: 'https://avatars.test/octocat' }), 0, NOW)
    expect(card.people).toEqual([expect.objectContaining({ id: 'octocat', avatarUrl: 'https://avatars.test/octocat' })])
    expect(taskBoardCard(issue(8), 0, NOW).people).toEqual([])
  })
})

describe('the chips', () => {
  test('a task label is the shared pastel pill in the accent, not a neutral ring', () => {
    // WHY: a label reads the same on a task row, a task page and a pull
    // request row. The colour is what selects the pill skin.
    expect(taskRow(issue(1, 'open', { labels: ['design'] }), 0, NOW).chips[0]).toEqual({
      label: 'design',
      labelColor: 'var(--solus-accent)',
    })
  })

  test('an overdue task says so until it is done', () => {
    // WHY: a due date in the past is a problem only while the work is open.
    const overdue = { dueDate: '2026-08-01', priority: 'urgent' as const }
    expect(taskRow(issue(1, 'active', overdue), 0, NOW).chips).toEqual([{ label: 'overdue', tint: 'failure' }])
    expect(taskRow(issue(1, 'done', overdue), 0, NOW).chips).toEqual([{ label: 'urgent', tint: 'failure' }])
    expect(taskRow(issue(1, 'open', { priority: 'high' }), 0, NOW).chips).toEqual([{ label: 'high', tint: 'warning' }])
    expect(taskRow(issue(1, 'open', { priority: 'low' }), 0, NOW).chips).toEqual([])
  })
})

describe('snoozed tasks', () => {
  test('a snooze holds until its wake time, whatever the status category', () => {
    // WHY: snooze is independent of the provider's state. A task returns to
    // the list at its wake time without anyone having to unsnooze it.
    for (const category of ['active', 'done'] as const) {
      const sleeping = { ...issue(1, category), snoozedUntil: NOW + 60_000 }
      expect(isTaskSnoozed(sleeping, NOW)).toBe(true)
      expect(isTaskSnoozed(sleeping, NOW + 60_000)).toBe(false)
    }
    expect(isTaskSnoozed(issue(1), NOW)).toBe(false)
  })

  test('the list wakes at the earliest wake time still ahead', () => {
    // WHY: the list sets one timer for the next task to return.
    const tasks = [
      { ...issue(1), snoozedUntil: NOW + 7_200_000 },
      { ...issue(2), snoozedUntil: NOW + 60_000 },
      { ...issue(3), snoozedUntil: NOW - 60_000 },
      issue(4),
    ]
    expect(nextTaskWake(tasks, NOW)).toBe(NOW + 60_000)
    expect(nextTaskWake([issue(4)], NOW)).toBeNull()
  })

  test('a snoozed row says when it comes back', () => {
    // WHY: the Snoozed filter is the way back to a hidden task, so each row
    // must show its return time.
    const row = taskRow({ ...issue(1), snoozedUntil: NOW + 3 * 3_600_000, priority: 'urgent' }, 0, NOW)
    expect(row.chips).toContainEqual(expect.objectContaining({ label: 'wakes in 3h' }))
    expect(row.chips.some((chip) => chip.label === 'urgent')).toBe(false)
  })
})
