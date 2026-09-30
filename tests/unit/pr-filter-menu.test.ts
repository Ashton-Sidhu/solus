import { describe, expect, test } from 'bun:test'
import { clearPrFilters, prFilterGroups } from '@solus/workspace-ui/components/prs/lib/pr-filter-menu'
import { emptyListView } from '@solus/workspace-ui/components/prs/lib/prs-list-view'

describe('clearPrFilters', () => {
  test('turns every Filters-menu group inactive and keeps the search', () => {
    // WHY: Clear filters sits in the Filters menu and answers its badge. The
    // search field is a separate control beside it, so clearing the menu must
    // not also throw away what the user typed.
    const listView = emptyListView()
    listView.query = 'label:bug'
    listView.statusKeys = ['merged']
    listView.involvement = 'created'
    listView.author = 'octocat'
    listView.label = 'bug'
    listView.draft = 'draft'
    listView.review = 'approved'
    listView.checks = 'failing'
    listView.guide = 'has-guide'
    listView.lens = 'has-lens'

    clearPrFilters(listView)

    const groups = prFilterGroups(listView, { authors: [], labels: [] }, () => {})
    expect(groups.filter((group) => group.active).map((group) => group.key)).toEqual([])
    expect(listView.query).toBe('label:bug')
  })
})
