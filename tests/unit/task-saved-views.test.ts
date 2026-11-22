import { describe, expect, test } from 'bun:test'
import {
  putTaskSavedView,
  taskSavedViewsSchema,
  type TaskSavedView
} from '@solus/contracts/task-views'

const view: TaskSavedView = {
  id: 'mine',
  name: 'My open work',
  filters: {
    sourceKey: null,
    query: '',
    layout: 'list',
    sort: 'priority',
    involvement: 'authored',
    runningOnly: false,
    overdueOnly: false,
    assignedOnly: false,
    snoozedOnly: false,
    columnIds: null
  }
}

describe('personal task views', () => {
  test('renaming keeps one identity and preserves the saved filters', () => {
    expect(putTaskSavedView([view], { ...view, name: 'Renamed' })).toEqual([
      { ...view, name: 'Renamed' }
    ])
  })
  test('refuses unbounded or invalid synced preferences', () => {
    expect(
      taskSavedViewsSchema.safeParse(
        Array.from({ length: 51 }, (_, i) => ({ ...view, id: String(i) }))
      ).success
    ).toBe(false)
    expect(taskSavedViewsSchema.safeParse([{ ...view, name: ' ' }]).success).toBe(false)
    expect(taskSavedViewsSchema.safeParse([view, view]).success).toBe(false)
    expect(
      taskSavedViewsSchema.safeParse([{ ...view, filters: { ...view.filters, sort: 'anything' } }])
        .success
    ).toBe(false)
  })
})

test('a saved no-column filter has the same meaning on the native list', async () => {
  const { tasksForSavedView } = await import('@solus/client-core/task-views')
  const { mobileTaskFilters } = await import('../../apps/mobile/solus-core/features/tasks/task-list')
  const task = {
    id: 'github:I1',
    providerId: 'github' as const,
    kind: 'issue' as const,
    title: 'Fix login',
    url: null,
    state: { name: 'Open', category: 'open' as const },
    category: 'open' as const,
    placements: [{ sourceKey: 'board', columnId: null }],
    labels: [],
    assignees: [{ login: 'ada' }],
    writableFields: [],
    updatedAt: 1
  }
  const saved = {
    ...view.filters,
    sourceKey: 'board',
    involvement: 'all' as const,
    columnIds: [''],
    assignedOnly: true
  }
  const filters = mobileTaskFilters(
    { sourceKey: 'board', query: '', involvement: 'all', status: 'all' },
    [],
    saved
  )
  expect(tasksForSavedView([task], filters, 10, new Set()).map((row) => row.id)).toEqual([task.id])
  expect(tasksForSavedView([task], { ...filters, runningOnly: true }, 10, new Set())).toEqual([])
  expect(
    tasksForSavedView([task], { ...filters, runningOnly: true }, 10, new Set([task.id]))
  ).toHaveLength(1)
})
