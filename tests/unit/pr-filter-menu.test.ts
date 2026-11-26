import { describe, expect, test } from 'bun:test'
import { clearPrFilters, prFilterGroups, prFilterHasMarks } from '@solus/workspace-ui/components/prs/lib/pr-filter-menu'
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

describe('filter menu marks', () => {
  const groups = prFilterGroups(emptyListView(), { authors: [{ value: '', label: 'Anyone' }], labels: [], search: () => {} }, () => {})
  const group = (key: string) => groups.find((candidate) => candidate.key === key)!

  // WHY: the State menu kept a leading slot for a mark but drew none, so its
  // words sat indented beside nothing. Each state wears the glyph its rows wear.
  test('each pull request state shows the glyph its rows show', () => {
    expect(group('state').options.every((option) => option.icon)).toBe(true)
    expect(prFilterHasMarks(group('state'))).toBe(true)
  })

  // WHY: a menu of words alone must not reserve an empty slot before each label.
  test('a menu with no marks keeps no leading slot', () => {
    expect(prFilterHasMarks(group('involvement'))).toBe(false)
    expect(prFilterHasMarks(group('guide'))).toBe(false)
  })

  test('the author menu keeps its slot for avatars', () => {
    expect(prFilterHasMarks(group('author'))).toBe(true)
  })
})

describe('label menu marks', () => {
  // WHY: every label row is colour coded. A label chosen earlier that the
  // loaded rows no longer carry must still line up with a mark, not a gap.
  test('a selected label that no loaded row carries still has a colour', () => {
    const listView = emptyListView()
    listView.labels = ['blocked']
    const labels = [{ value: '', label: 'Any' }, { value: 'bug', label: 'bug', color: '#d73a4a' }]
    const group = prFilterGroups(listView, { authors: [], labels, search: () => {} }, () => {}).find((candidate) => candidate.key === 'labels')!
    expect(group.options.filter((option) => option.value).every((option) => option.color)).toBe(true)
  })
})
