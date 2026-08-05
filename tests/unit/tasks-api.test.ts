import { describe, expect, test } from 'bun:test'
import type { Task } from '../../src/shared/task-types'
import { buildBoard } from '../../src/renderer/components/tasks/lib/tasks-api'

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
