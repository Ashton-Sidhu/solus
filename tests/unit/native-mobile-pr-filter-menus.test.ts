import { describe, expect, test } from 'bun:test'
import { pullRequestListFilterMenus } from '../../apps/mobile/src/features/prs/lib/filter-menus'
import { DEFAULT_PULL_REQUEST_LIST_PREFERENCES, type PullRequestListPreferences } from '../../apps/mobile/src/features/workspace/list-preferences'

function menus(value = DEFAULT_PULL_REQUEST_LIST_PREFERENCES) {
  const changes: PullRequestListPreferences[] = []
  const searches: string[] = []
  const filters = pullRequestListFilterMenus({
    value, hosts: [{ id: 'host-a', label: 'Host A' }], hostId: value.hostId,
    project: value.project, projects: [], labels: ['bug'], authors: ['alice'],
    onChange: (next) => changes.push(next), onSearch: (field) => searches.push(field),
  })
  return { filters, changes, searches }
}

describe('pull request menu placement', () => {
  test('the Android header includes all filters, with reset last', () => {
    const { filters } = menus()
    expect(filters.headerMenu.actions.map((action) => action.title)).toEqual([
      'Host', 'State', 'Involvement', 'Labels', 'Author', 'Drafts', 'Reviews', 'Checks', 'Project', 'Recently updated', 'Reset filters',
    ])
    expect(filters.headerMenu.customized).toBe(false)
  })

  test('header reset clears host scope, while the iOS More reset keeps it', () => {
    const { filters, changes } = menus({ ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, hostId: 'host-a' })
    const headerReset = filters.headerMenu.actions.at(-1)!
    expect(headerReset.attributes?.disabled).toBe(false)
    expect(filters.headerMenu.customized).toBe(true)
    filters.headerMenu.onSelect(headerReset.id)
    expect(changes.at(-1)?.hostId).toBeNull()
    filters.select(filters.more.at(-1)!.id)
    expect(changes.at(-1)?.hostId).toBe('host-a')
  })

  test('header and pill choices use the same selection and search handlers', () => {
    const { filters, changes, searches } = menus()
    filters.headerMenu.onSelect(JSON.stringify(['state', 'closed']))
    expect(changes.at(-1)?.state).toBe('closed')
    filters.headerMenu.onSelect(filters.labelActions[0]!.id)
    filters.select(filters.authorActions[0]!.id)
    expect(searches).toEqual(['label', 'author'])
  })
})
