import { describe, expect, test } from 'bun:test'
import {
  putTaskSavedView,
  issueSavedViewsSchema,
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
      issueSavedViewsSchema.safeParse(
        Array.from({ length: 51 }, (_, i) => ({ ...view, id: String(i) }))
      ).success
    ).toBe(false)
    expect(issueSavedViewsSchema.safeParse([{ ...view, name: ' ' }]).success).toBe(false)
    expect(issueSavedViewsSchema.safeParse([view, view]).success).toBe(false)
    expect(
      issueSavedViewsSchema.safeParse([{ ...view, filters: { ...view.filters, sort: 'anything' } }])
        .success
    ).toBe(false)
  })
})
