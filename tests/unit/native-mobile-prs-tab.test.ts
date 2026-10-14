import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { pullRequestListMenuChoice } from '../../apps/mobile/src/features/prs/lib/list-filter-menu'
import {
  activePullRequestFilterCount,
  DEFAULT_PULL_REQUEST_LIST_PREFERENCES,
  DEFAULT_THREAD_LIST_FILTERS,
  PULL_REQUEST_LIST_FILTERS_KEY,
  pullRequestPreferencesForHost,
  readPullRequestListPreferences,
  readThreadListFilters,
  resolvePullRequestListScope,
  THREAD_LIST_FILTERS_KEY,
  type PullRequestListPreferences,
} from '../../apps/mobile/src/features/workspace/list-preferences'
import { INITIAL_WORKSPACE_TABS_STATE, workspaceTabsReducer } from '../../apps/mobile/src/features/workspace/workspace-tabs-state'

// The mobile workspace has two root tabs, Chats and Pull Requests
// (docs/plans/mobile-pull-requests.md). These tests pin what the person
// relies on: the tab they chose and its search behave predictably, the
// filters they set come back on the next launch, a host that is offline does
// not lose its place in the filters, and a host's "Open pull requests" is
// the tab narrowed to that host.

const saved = (key: string, value: unknown) => {
  const storage = memoryKeyValueStore()
  storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
  return storage
}

const preferences = (overrides: Partial<PullRequestListPreferences> = {}): PullRequestListPreferences => ({ ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, ...overrides })

describe('workspace tabs', () => {
  const search = (query: string) =>
    workspaceTabsReducer(workspaceTabsReducer(INITIAL_WORKSPACE_TABS_STATE, { type: 'search' }), { type: 'query', query })

  test('a tab change clears the search and closes its field, because each tab gets a new native search field', () => {
    const searching = search('fix')
    expect(searching).toEqual({ selectedTab: 'chats', query: 'fix', searchMode: 'active' })
    expect(workspaceTabsReducer(searching, { type: 'select', tab: 'pullRequests' })).toEqual({ selectedTab: 'pullRequests', query: '', searchMode: 'resting' })
  })

  test('choosing the tab already shown keeps its search', () => {
    const searching = search('fix')
    expect(workspaceTabsReducer(searching, { type: 'select', tab: 'chats' })).toBe(searching)
  })

  test('a search field that loses focus stays open with its text; cancel clears it and closes it', () => {
    // An open field that is not "active" is not focused again when the header is set again.
    const blurred = workspaceTabsReducer(search('fix'), { type: 'expand' })
    expect(blurred).toEqual({ selectedTab: 'chats', query: 'fix', searchMode: 'expanded' })
    expect(workspaceTabsReducer(INITIAL_WORKSPACE_TABS_STATE, { type: 'expand' })).toBe(INITIAL_WORKSPACE_TABS_STATE)
    expect(workspaceTabsReducer(blurred, { type: 'cancel' })).toEqual(INITIAL_WORKSPACE_TABS_STATE)
  })
})

describe('saved list filters (T3 #18476)', () => {
  test('valid saved filters come back on the next launch', () => {
    const threadFilters = { environmentId: 'host-a', projectKey: 'repo:app' }
    expect(readThreadListFilters(saved(THREAD_LIST_FILTERS_KEY, threadFilters))).toEqual(threadFilters)
    const pullRequests = preferences({
      state: 'all',
      hostId: 'host-a',
      project: { hostId: 'host-a', projectPath: '/work/app' },
      involvement: 'reviewing',
      filters: { labels: [['size:S']], draft: 'hide', checks: 'failing' },
      sort: 'oldest',
    })
    expect(readPullRequestListPreferences(saved(PULL_REQUEST_LIST_FILTERS_KEY, pullRequests))).toEqual(pullRequests)
  })

  test('a malformed saved value is dropped as a whole, not half applied', () => {
    expect(readThreadListFilters(saved(THREAD_LIST_FILTERS_KEY, { environmentId: 1, projectKey: null }))).toEqual(DEFAULT_THREAD_LIST_FILTERS)
    expect(readPullRequestListPreferences(saved(PULL_REQUEST_LIST_FILTERS_KEY, { ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, sort: 'newest' }))).toEqual(DEFAULT_PULL_REQUEST_LIST_PREFERENCES)
    expect(readPullRequestListPreferences(saved(PULL_REQUEST_LIST_FILTERS_KEY, '{not json'))).toEqual(DEFAULT_PULL_REQUEST_LIST_PREFERENCES)
    expect(readPullRequestListPreferences(memoryKeyValueStore())).toEqual(DEFAULT_PULL_REQUEST_LIST_PREFERENCES)
  })
})

describe('pull request list scope', () => {
  test('a saved host stays selected while it is paired, connected or not', () => {
    // Paired hosts, not connected ones, decide: an offline host shows its device copy.
    const scope = resolvePullRequestListScope(preferences({ hostId: 'b' }), ['a', 'b'])
    expect(scope.hostId).toBe('b')
    expect(scope.hostIds).toEqual(['b'])
    expect(scope.controls.hostId).toBe('b')
  })

  test('a saved project narrows the list to its own host and folder', () => {
    const project = { hostId: 'b', projectPath: '/work/app' }
    const scope = resolvePullRequestListScope(preferences({ project }), ['a', 'b'])
    expect(scope.project).toEqual(project)
    expect(scope.hostIds).toEqual(['b'])
    expect(scope.controls).toMatchObject({ hostId: 'b', projectPath: '/work/app' })
  })

  test('a host that is no longer paired reads as every host, and its project no longer applies', () => {
    const scope = resolvePullRequestListScope(preferences({ hostId: 'gone', project: { hostId: 'gone', projectPath: '/x' } }), ['a', 'b'])
    expect(scope).toMatchObject({ hostId: null, project: null, hostIds: ['a', 'b'] })
    expect(scope.controls.hostId).toBeUndefined()
    expect(scope.controls.projectPath).toBeUndefined()
  })

  test("a host's Open pull requests keeps that host's project and drops another host's", () => {
    const project = { hostId: 'a', projectPath: '/work/app' }
    expect(pullRequestPreferencesForHost(preferences({ project, involvement: 'authored' }), 'a')).toMatchObject({ hostId: 'a', project, involvement: 'authored' })
    expect(pullRequestPreferencesForHost(preferences({ project }), 'b')).toMatchObject({ hostId: 'b', project: null })
  })
})

describe('pull request filter menus', () => {
  const context = (value: PullRequestListPreferences) => ({ value, hostIds: ['a', 'b'], projects: [{ hostId: 'a', projectPath: '/work/app' }] })
  const choose = (value: PullRequestListPreferences, field: string, choice: string) => pullRequestListMenuChoice(JSON.stringify([field, choice]), context(value))

  test('a choice the menu did not offer changes nothing', () => {
    expect(choose(preferences(), 'state', 'merged')).toBeNull()
    expect(choose(preferences(), 'host', 'unknown')).toBeNull()
    expect(choose(preferences(), 'project', JSON.stringify(['b', '/elsewhere']))).toBeNull()
    expect(pullRequestListMenuChoice('not json', context(preferences()))).toBeNull()
  })

  test('labels toggle one at a time, and every chosen label must match', () => {
    const one = choose(preferences(), 'label', 'bug')!
    const two = choose(one, 'label', 'ui')!
    expect(two.filters.labels).toEqual([['bug'], ['ui']])
    expect(choose(two, 'label', 'bug')!.filters.labels).toEqual([['ui']])
    expect(choose(two, 'labels', '')!.filters.labels).toBeUndefined()
  })

  test('"All" removes a filter rather than saving it as a value', () => {
    const drafts = choose(preferences(), 'draft', 'hide')!
    expect(drafts.filters).toEqual({ draft: 'hide' })
    expect(choose(drafts, 'draft', 'all')!.filters).toEqual({})
  })

  test('choosing a project records its host; reset keeps the chosen host', () => {
    const value = choose(preferences({ hostId: 'a' }), 'project', JSON.stringify(['a', '/work/app']))!
    expect(value.project).toEqual({ hostId: 'a', projectPath: '/work/app' })
    expect(activePullRequestFilterCount(value)).toBe(1)
    const reset = choose({ ...value, state: 'closed', involvement: 'others' }, 'reset', '')!
    expect(reset).toEqual({ ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, hostId: 'a' })
    expect(activePullRequestFilterCount(reset)).toBe(0)
  })
})

describe('the iOS workspace tab bar', () => {
  const mobile = join(import.meta.dir, '../../apps/mobile/src')
  const read = (path: string) => readFileSync(join(mobile, path), 'utf8')

  test('UIKit draws Chats and Pull Requests; compose is its search-role tab that opens New Task and is never selected', () => {
    const tabs = read('features/workspace/WorkspaceNativeTabs.ios.tsx')
    expect(tabs).toContain('const TABS = ["chats", "pullRequests"] as const')
    expect(tabs).toMatch(/screenKey=\{COMPOSE_TAB\}[\s\S]*preventNativeSelection[\s\S]*role: "search"/)
    expect(tabs).toContain('if (nativeEvent.preventedScreenKey === COMPOSE_TAB) props.onNewTask()')
    expect(read('features/layout/createWorkspaceStackNavigator.ios.tsx')).toContain('onNewTask={() => props.navigation.navigate("NewTask")}')
  })

  test('the JavaScript dock is gone', () => {
    expect(() => read('features/workspace/WorkspaceDock.tsx')).toThrow()
    expect(read('navigation/RootNavigator.tsx')).toContain('createWorkspaceStackNavigator<RootStackParamList>()')
  })
})

describe('the per-host pull request route is gone', () => {
  const source = join(import.meta.dir, '../../apps/mobile/src')
  const files = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(entry) ? [path] : []
  })

  test('nothing navigates to a PullRequests route; a host opens the Pull Requests tab instead', () => {
    const callers = files(source).filter((path) => /navigate\(\s*['"]PullRequests['"]/.test(readFileSync(path, 'utf8')))
    expect(callers).toEqual([])
    expect(readFileSync(join(source, 'navigation/routes.ts'), 'utf8')).not.toMatch(/^\s*PullRequests:/m)
    expect(readFileSync(join(source, 'features/threads/useThreadHeaderOptions.tsx'), 'utf8')).toContain('popTo("Home", { tab: "pullRequests", hostId })')
  })
})
