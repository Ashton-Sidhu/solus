import { describe, expect, test } from 'bun:test'
import type { Task, TaskColumn, TaskPlacement } from '@solus/contracts/task-types'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'
import {
  buildBoard,
  boardColumnIdOf,
  boardViewId,
  CATEGORY_META,
  DEFAULT_TASK_SORT,
  moveTargetFor,
  NO_COLUMN_ID,
  sortTasks,
  TASK_CATEGORIES,
  taskPlacementLabels,
  taskRef,
  type BoardView,
} from '@solus/workspace-ui/components/tasks/lib/tasks-api'

const REPO = 'github-repo:acme/app'
const BOARD = 'github-project:acme/7'

// The board's columns in the provider's order, which is not the order of the
// status categories: "In review" comes after "Shipped" on this board.
const BOARD_COLUMNS: TaskColumn[] = [
  { id: 'opt-todo', name: 'Backlog', category: 'open' },
  { id: 'opt-done', name: 'Shipped', category: 'done' },
  { id: 'opt-review', name: 'In review', category: 'active' },
]
const boardView: BoardView = { kind: 'source', source: { sourceKey: BOARD, columns: BOARD_COLUMNS } }
const allView: BoardView = { kind: 'all' }

function task(id: string, category: TaskStatusCategory, placements: TaskPlacement[]): Pick<Task, 'id' | 'category' | 'placements'> {
  return { id, category, placements }
}

const idsByColumn = (columns: ReturnType<typeof buildBoard<ReturnType<typeof task>>>) =>
  columns.map((column) => [column.label, column.tasks.map((row) => row.id)])

describe('the board of one task source', () => {
  test('shows the columns of the provider, with its names, in its order', () => {
    // WHY: a board shows the provider's columns as they are (decision 7). A
    // board that sorted them by status category would not look like the
    // GitHub Project or the Jira board the team works on.
    const columns = buildBoard([], boardView)
    expect(columns.map((column) => column.label)).toEqual(['Backlog', 'Shipped', 'In review'])
    expect(columns.map((column) => column.id)).toEqual(['opt-todo', 'opt-done', 'opt-review'])
    expect(columns.map((column) => column.category)).toEqual(['open', 'done', 'active'])
  })

  test('puts each task in its column of this source, not in the column of another source', () => {
    // WHY: a task on two boards shows in each board's own view with that
    // board's column (decision 10).
    const columns = buildBoard([
      task('on-both', 'active', [{ sourceKey: REPO, columnId: 'open' }, { sourceKey: BOARD, columnId: 'opt-review' }]),
      task('backlog', 'open', [{ sourceKey: BOARD, columnId: 'opt-todo' }]),
    ], boardView)

    expect(idsByColumn(columns)).toEqual([
      ['Backlog', ['backlog']],
      ['Shipped', []],
      ['In review', ['on-both']],
    ])
  })

  test('a task that the source does not list is absent', () => {
    // WHY: the page hands the board every task of the project. A source view
    // must show only the tasks of that source, or a repository issue would
    // show on a board it is not on.
    const columns = buildBoard([task('repo-only', 'open', [{ sourceKey: REPO, columnId: 'open' }])], boardView)
    expect(columns.flatMap((column) => column.tasks)).toEqual([])
    expect(columns.map((column) => column.label)).toEqual(['Backlog', 'Shipped', 'In review'])
  })

  test('a task with no column, or with a column the source did not report, goes to a leading "No column"', () => {
    // WHY: a GitHub Project item can have no Status, and a column can be
    // removed between two reads. The card must not vanish from the board.
    const columns = buildBoard([
      task('no-status', 'open', [{ sourceKey: BOARD, columnId: null }]),
      task('removed-column', 'open', [{ sourceKey: BOARD, columnId: 'opt-deleted' }]),
      task('backlog', 'open', [{ sourceKey: BOARD, columnId: 'opt-todo' }]),
    ], boardView)

    expect(idsByColumn(columns)).toEqual([
      ['No column', ['no-status', 'removed-column']],
      ['Backlog', ['backlog']],
      ['Shipped', []],
      ['In review', []],
    ])
    expect(columns[0].id).toBe(NO_COLUMN_ID)
    // Work with no column is still open work: a list that hides done columns keeps it.
    expect(columns[0].category).toBe('open')
  })

  test('there is no "No column" when each task has a column', () => {
    // WHY: an always-empty first column reads as a broken board.
    const columns = buildBoard([task('backlog', 'open', [{ sourceKey: BOARD, columnId: 'opt-todo' }])], boardView)
    expect(columns.some((column) => column.id === NO_COLUMN_ID)).toBe(false)
  })

  test('keeps the order the page gave the tasks', () => {
    // WHY: the board is the list re-plotted. The page already sorted the tasks.
    const columns = buildBoard([
      task('second', 'open', [{ sourceKey: BOARD, columnId: 'opt-todo' }]),
      task('first', 'open', [{ sourceKey: BOARD, columnId: 'opt-todo' }]),
    ], boardView)
    expect(columns[0].tasks.map((row) => row.id)).toEqual(['second', 'first'])
  })
})

describe('the board of all sources', () => {
  test('has one column for each status category: Open, Active, Done', () => {
    // WHY: columns of two sources do not line up. The status category is the
    // one fact Solus has for each of them (plan §7).
    expect(buildBoard([], allView).map((column) => [column.id, column.label])).toEqual([
      ['open', 'Open'],
      ['active', 'Active'],
      ['done', 'Done'],
    ])
    expect(TASK_CATEGORIES.map((category) => CATEGORY_META[category].label)).toEqual(['Open', 'Active', 'Done'])
  })

  test('shows each task once, by its category, however many sources list it', () => {
    // WHY: a task in two sources of a project is one task (decision 10). Its
    // column on one board must not put it in a second category column.
    const columns = buildBoard([
      task('on-both', 'active', [{ sourceKey: REPO, columnId: 'open' }, { sourceKey: BOARD, columnId: 'opt-review' }]),
      task('closed', 'done', [{ sourceKey: REPO, columnId: 'closed' }]),
      task('linked-only', 'open', []),
    ], allView)

    expect(idsByColumn(columns)).toEqual([
      ['Open', ['linked-only']],
      ['Active', ['on-both']],
      ['Done', ['closed']],
    ])
  })
})

describe('boardColumnIdOf', () => {
  test('answers the category in the mixed view, the column in a source view, and null for a task the source does not list', () => {
    const onBoard = task('a', 'active', [{ sourceKey: BOARD, columnId: 'opt-review' }])
    expect(boardColumnIdOf(onBoard, allView)).toBe('active')
    expect(boardColumnIdOf(onBoard, boardView)).toBe('opt-review')
    expect(boardColumnIdOf(task('b', 'open', [{ sourceKey: BOARD, columnId: null }]), boardView)).toBe(NO_COLUMN_ID)
    expect(boardColumnIdOf(task('c', 'open', [{ sourceKey: REPO, columnId: 'open' }]), boardView)).toBeNull()
  })
})

describe('what a drop on a column asks the host to do', () => {
  test('a source view names the source and the column', () => {
    // WHY: the person chose a provider column, so the provider gets exactly
    // that column. A category would let the host pick another column.
    expect(moveTargetFor(boardView, 'opt-review')).toEqual({ sourceKey: BOARD, columnId: 'opt-review' })
  })

  test('the mixed view names a status category, and the host chooses the column of each source', () => {
    expect(moveTargetFor(allView, 'done')).toEqual({ category: 'done' })
    expect(moveTargetFor(allView, 'opt-review')).toBeNull()
  })

  test('nothing can be moved into "No column"', () => {
    // WHY: no provider has that column. It only holds what has no column.
    expect(moveTargetFor(boardView, NO_COLUMN_ID)).toBeNull()
    expect(moveTargetFor(allView, NO_COLUMN_ID)).toBeNull()
  })

  test('a view is keyed by its source, so the order a person gave one board does not leak into another', () => {
    expect(boardViewId(allView)).toBe('all')
    expect(boardViewId(boardView)).toBe(BOARD)
  })
})

describe('taskRef', () => {
  test('a row names a task as its provider does', () => {
    // WHY: a task has no Solus number. The reference is the provider's, and a
    // row leaves out the repository because its cell is narrow.
    expect(taskRef({ kind: 'issue', reference: 'acme/app#123' })).toBe('#123')
    expect(taskRef({ kind: 'issue', reference: 'SOL-12' })).toBe('SOL-12')
  })

  test('a draft item has no reference and says that it is a draft', () => {
    expect(taskRef({ kind: 'draft', reference: undefined })).toBe('Draft')
    expect(taskRef({ kind: 'issue', reference: undefined })).toBe('')
  })
})

describe('taskPlacementLabels', () => {
  const sources = new Map([
    [BOARD, { label: 'Roadmap', columns: BOARD_COLUMNS }],
    [REPO, { label: 'acme/app', columns: [{ id: 'open', name: 'Open', category: 'open' as const }] }],
  ])

  test('names the column of the task in each source that lists it, with the columns it can move to', () => {
    // WHY: the task page shows the status as the column in each source, and
    // its move menu offers the columns of that source only.
    const labels = taskPlacementLabels({
      placements: [{ sourceKey: REPO, columnId: 'open' }, { sourceKey: BOARD, columnId: 'opt-review' }],
    }, sources)

    expect(labels.map(({ sourceLabel, columnName, columnId }) => ({ sourceLabel, columnName, columnId }))).toEqual([
      { sourceLabel: 'acme/app', columnName: 'Open', columnId: 'open' },
      { sourceLabel: 'Roadmap', columnName: 'In review', columnId: 'opt-review' },
    ])
    expect(labels[1].columns).toBe(BOARD_COLUMNS)
  })

  test('a board item with no column has no column name', () => {
    const [label] = taskPlacementLabels({ placements: [{ sourceKey: BOARD, columnId: null }] }, sources)
    expect(label.columnName).toBeNull()
    expect(label.columns).toBe(BOARD_COLUMNS)
  })

  test('a source that no host described yet is named by its key and offers no column', () => {
    // WHY: the placement arrives with the task; the source state can arrive
    // later. The row must not be dropped while it waits.
    expect(taskPlacementLabels({ placements: [{ sourceKey: 'jira-board:cloud-1/4', columnId: '10' }] }, sources)).toEqual([
      { sourceKey: 'jira-board:cloud-1/4', sourceLabel: 'jira-board:cloud-1/4', columnName: null, columns: [], columnId: '10' },
    ])
  })
})

describe('task list sort', () => {
  type Sortable = Pick<Task, 'id' | 'priority' | 'dueDate' | 'updatedAt' | 'createdAt'>
  const row = (id: string, fields: Partial<Sortable> = {}): Sortable => ({ id, updatedAt: 0, ...fields })
  const ids = (rows: Sortable[]) => rows.map(({ id }) => id)

  test('defaults to newest-created and keeps tasks without a creation time ordered by their update', () => {
    // WHY: a new task should start at the top of the list even when an older
    // task receives activity. A provider that omits the creation time still
    // needs a deterministic place instead of producing a NaN comparator.
    expect(DEFAULT_TASK_SORT).toBe('created')
    const older = row('older', { createdAt: 10, updatedAt: 100 })
    const newer = row('newer', { createdAt: 20, updatedAt: 20 })
    const noCreationTime = row('no-creation-time', { updatedAt: 15 })

    expect(ids(sortTasks([older, noCreationTime, newer], DEFAULT_TASK_SORT))).toEqual(['newer', 'no-creation-time', 'older'])
  })

  test('priority puts urgent work first, then the nearer due date, and tasks with no priority last', () => {
    // WHY: "what is next" is the urgent task that is due soon, not the task
    // that somebody touched last.
    const rows = [
      row('none', { updatedAt: 99 }),
      row('high-later', { priority: 'high', dueDate: '2026-12-20' }),
      row('urgent', { priority: 'urgent' }),
      row('high-sooner', { priority: 'high', dueDate: '2026-12-01' }),
    ]
    expect(ids(sortTasks(rows, 'priority'))).toEqual(['urgent', 'high-sooner', 'high-later', 'none'])
  })

  test('due puts the nearest date first, and tasks with no due date last', () => {
    const rows = [
      row('no-date', { priority: 'urgent' }),
      row('later', { dueDate: '2026-12-20' }),
      row('sooner', { dueDate: '2026-12-01' }),
    ]
    expect(ids(sortTasks(rows, 'due'))).toEqual(['sooner', 'later', 'no-date'])
  })

  test('updated puts the most recent change first, and does not change the array it is given', () => {
    const rows = [row('old', { updatedAt: 1 }), row('new', { updatedAt: 2 })]
    expect(ids(sortTasks(rows, 'updated'))).toEqual(['new', 'old'])
    expect(ids(rows)).toEqual(['old', 'new'])
  })
})
