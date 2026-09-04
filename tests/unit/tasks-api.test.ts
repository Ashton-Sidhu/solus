import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import {
  buildBoard,
  DEFAULT_TASK_SORT,
  sortTasks,
  STATUS_META,
  TASK_STATUSES,
} from '@solus/workspace-ui/components/tasks/lib/tasks-api'

function task(id: string, status: Task['status'], providerId: Task['providerId']): Task {
  return {
    id,
    providerId,
    kind: 'task',
    title: id,
    body: '',
    status,
    url: null,
    labels: [],
    updatedAt: 0,
  }
}

describe('buildBoard', () => {
  test('orders columns as a left-to-right workflow', () => {
    // WHY: a Kanban board must move from ready work through active work and
    // review to completion. Attention-based list ordering is confusing here.
    expect(buildBoard([]).map((column) => column.status)).toEqual([
      'todo',
      'in_progress',
      'in_review',
      'done',
    ])
  })

  test('every lifecycle status lands in a column', () => {
    // WHY: the board has four columns for six statuses; inbox folds into todo
    // and dropped into done, or those tasks would silently vanish when the
    // board layout is chosen.
    const columns = buildBoard([
      task('untriaged', 'inbox', 'local'),
      task('ready', 'todo', 'local'),
      task('github-issue', 'todo', 'github'),
      task('abandoned', 'dropped', 'local'),
      task('shipped', 'done', 'local'),
    ])

    expect(columns.find((column) => column.status === 'todo')?.tasks.map((row) => row.id))
      .toEqual(['untriaged', 'ready', 'github-issue'])
    expect(columns.find((column) => column.status === 'done')?.tasks.map((row) => row.id))
      .toEqual(['abandoned', 'shipped'])
  })
})

describe('task list sort', () => {
  test('defaults to newest-created and keeps tasks without a creation time ordered by their update', () => {
    // WHY: a new task should start at the top of the list even when an older
    // task receives activity. Provider tasks that omit createdAt still need a
    // deterministic place instead of producing a NaN comparator.
    expect(DEFAULT_TASK_SORT).toBe('created')
    const older = { ...task('older', 'todo', 'local'), createdAt: 10, updatedAt: 100 }
    const newer = { ...task('newer', 'todo', 'local'), createdAt: 20, updatedAt: 20 }
    const providerFallback = { ...task('provider', 'todo', 'github'), updatedAt: 15 }

    expect(sortTasks([older, providerFallback, newer], DEFAULT_TASK_SORT).map(({ id }) => id)).toEqual([
      'newer',
      'provider',
      'older',
    ])
  })
})

describe('task status colours', () => {
  test('uses lifecycle semantics instead of the brown brand accent', () => {
    // WHY: status colour is information. Active, review, complete, and dropped
    // work must remain visually distinct from the product brand and each other.
    expect(STATUS_META.in_progress.token).toBe('--running')
    expect(STATUS_META.in_review.token).toBe('--review')
    expect(STATUS_META.done.token).toBe('--success')
    expect(STATUS_META.dropped.token).toBe('--idle')
  })
})

describe('TASK_STATUSES', () => {
  test('offers every status a task can hold', () => {
    // WHY: the sidebar row menu, the task picker's row menu, and the picker
    // preview's status control all walk this one list. A status missing here is
    // a move the user simply cannot make from any of those surfaces — with no
    // error to say so — so adding a status must add it to every menu at once.
    expect([...TASK_STATUSES].sort()).toEqual(Object.keys(STATUS_META).sort())
  })
})
