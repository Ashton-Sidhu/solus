import { describe, expect, test } from 'bun:test'
import type { AppSummary } from '@solus/contracts/apps'
import type { AppRow } from '@solus/workspace-ui/contexts/apps/apps.store.svelte'
import {
  appProjectOptions,
  appTimeCounts,
  applyAppFilter,
  calls24hText,
  buildWorkspaceAppItems,
  groupAppItems,
  sortAppItems,
  type WorkspaceAppSources,
} from '@solus/workspace-ui/components/workspace/lib/workspace-apps'
import { DEFAULT_FILTER } from '@solus/workspace-ui/components/workspace/lib/workspace-items'

const DAY = 86_400_000
/** A Wednesday at noon, so "this week" and "yesterday" are different buckets. */
const NOW = new Date(2026, 10, 11, 12)

function row(serverId: string, id: string, patch: Partial<AppSummary> = {}): AppRow {
  return {
    serverId,
    app: {
      id,
      slug: id,
      name: id,
      description: '',
      organizationId: 'local',
      activeVersion: 1,
      latestVersion: 1,
      latestRevision: 'a'.repeat(40),
      hasUndeployedRevision: false,
      buildingVersion: null,
      stopped: false,
      agentAccess: true,
      hasUi: true,
      operationCount: 1,
      project: '/Users/ada/code/notes',
      createdBy: { kind: 'system' },
      createdAt: 0,
      updatedAt: NOW.getTime(),
      lastCallAt: null,
      calls24h: 0,
      failed24h: 0,
      attention: [],
      ...patch,
    },
  }
}

const sources: WorkspaceAppSources = {
  hostLabel: (serverId) => (serverId === 'h1' ? 'Studio' : 'Laptop'),
  projectKeyOf: (serverId, folder) => `${serverId}:${folder}`,
  optionsFor: (keys) => [...new Set(keys)].map((key) => ({ key, label: `project ${key.split('/').at(-1)}` })),
}

describe('an app card of the Workspace page', () => {
  test('missing host counts do not stop rendering or imply that no calls occurred', () => {
    for (const missing of [['calls24h'], ['failed24h'], ['calls24h', 'failed24h']]) {
      const source = row('h1', 'notes', { calls24h: 12, failed24h: 2 })
      // Simulate a summary sent by a host that omits these fields.
      for (const field of missing) Reflect.deleteProperty(source.app, field)
      const [item] = buildWorkspaceAppItems([source], sources)
      expect(calls24hText(item!)).toBe('Call counts unavailable')
    }
  })

  test('it names the host, the state, the active version, the calls of 24 hours, the folder, the last call, and what needs the owner', () => {
    // WHY: the card is where the owner sees that an app needs them without opening it.
    const attention = [{ kind: 'secret-missing' as const, detail: 'The secret Database URL is not set.' }]
    const [item] = buildWorkspaceAppItems([row('h1', 'notes', { name: 'Notes', activeVersion: 3, lastCallAt: NOW.getTime() - 60_000, calls24h: 12, failed24h: 2, hasUndeployedRevision: true, attention })], sources)
    expect(item).toMatchObject({
      rowKey: 'app:h1:notes',
      serverId: 'h1',
      slug: 'notes',
      title: 'Notes',
      hostLabel: 'Studio',
      state: 'running',
      activeVersion: 3,
      calls24h: 12,
      failed24h: 2,
      hasUndeployedRevision: true,
      folderName: 'notes',
      projectKey: 'h1:/Users/ada/code/notes',
      projectLabel: 'project notes',
      lastCallAt: NOW.getTime() - 60_000,
      problems: [{ kind: 'secret-missing', tone: 'warning', section: 'secrets' }],
    })
    expect(calls24hText(item!)).toBe('12 calls in 24 hours, 2 failed')
    expect(calls24hText({ calls24h: 1, failed24h: 0 })).toBe('1 call in 24 hours')
    expect(calls24hText({ calls24h: 0, failed24h: 0 })).toBe('No calls in 24 hours')
  })

  test('the state is running, stopped, with no version, or building', () => {
    // WHY: stopped is the owner's own choice. It is the state of the card, not one of its problems.
    const stopped = { stopped: true, attention: [{ kind: 'stopped' as const, detail: 'The app is stopped.' }] }
    // An app's summary says that a version builds, so the tab shows it for every app, not only for one whose Manage page is open.
    const items = buildWorkspaceAppItems([row('h1', 'running'), row('h1', 'stopped', stopped), row('h1', 'new', { activeVersion: null }), row('h1', 'building', { buildingVersion: 4 })], sources)
    const states = Object.fromEntries(items.map((item) => [item.appId, item.state]))
    expect(states).toEqual({ running: 'running', stopped: 'stopped', new: 'no-version', building: 'building' })
    expect(items.find((item) => item.appId === 'stopped')?.problems).toEqual([])
  })

  test('a failed workflow is an error that leads to the Workflows section', () => {
    const [item] = buildWorkspaceAppItems([row('h1', 'reports', { attention: [{ kind: 'workflow-failed', detail: 'The run of build failed.' }] })], sources)
    expect(item?.problems).toEqual([{ kind: 'workflow-failed', detail: 'The run of build failed.', tone: 'error', section: 'workflows', action: 'Open Workflows' }])
  })

  test('an app with no folder and no version says so, and files under no project', () => {
    const [item] = buildWorkspaceAppItems([row('h1', 'loose', { project: null, activeVersion: null })], sources)
    expect(item).toMatchObject({ activeVersion: null, folderName: '', projectKey: '', projectLabel: 'No project' })
    expect(appProjectOptions([item!])).toEqual([])
  })

  test('two hosts can hold the same app id: each card has its own key', () => {
    const items = buildWorkspaceAppItems([row('h1', 'notes'), row('h2', 'notes')], sources)
    expect(new Set(items.map((item) => item.rowKey)).size).toBe(2)
  })

  test('an app moves when it changes or when it is called, so a used app leads the list', () => {
    // WHY: an app that a schedule calls every hour is alive. It must not sink under an app deployed yesterday and never used.
    const items = buildWorkspaceAppItems([
      row('h1', 'deployed-yesterday', { updatedAt: NOW.getTime() - DAY }),
      row('h1', 'called-now', { updatedAt: NOW.getTime() - 30 * DAY, lastCallAt: NOW.getTime() }),
    ], sources)
    expect(items.map((item) => item.appId)).toEqual(['called-now', 'deployed-yesterday'])
    expect(sortAppItems(items, 'oldest').map((item) => item.appId)).toEqual(['deployed-yesterday', 'called-now'])
  })
})

describe('the filters of the Apps tab', () => {
  const items = buildWorkspaceAppItems([
    row('h1', 'notes', { name: 'Notes', description: 'Quick notes', updatedAt: NOW.getTime() }),
    row('h2', 'budget', { name: 'Budget', project: '/Users/ada/code/money', updatedAt: NOW.getTime() - DAY }),
    row('h1', 'old', { name: 'Old tracker', updatedAt: NOW.getTime() - 60 * DAY }),
  ], sources)

  test('the search reads the name, the description, the slug, the host, and the folder', () => {
    const find = (text: string) => applyAppFilter(items, { ...DEFAULT_FILTER, text }, NOW).map((item) => item.appId)
    expect(find('quick')).toEqual(['notes'])
    expect(find('LAPTOP')).toEqual(['budget'])
    expect(find('money')).toEqual(['budget'])
    expect(find('old')).toEqual(['old'])
    expect(find('  ')).toEqual(['notes', 'budget', 'old'])
    expect(find('nothing')).toEqual([])
  })

  test('the project and the time facets cut the apps', () => {
    expect(applyAppFilter(items, { ...DEFAULT_FILTER, project: 'h2:/Users/ada/code/money' }, NOW).map((item) => item.appId)).toEqual(['budget'])
    expect(applyAppFilter(items, { ...DEFAULT_FILTER, time: 'today' }, NOW).map((item) => item.appId)).toEqual(['notes'])
    expect(applyAppFilter(items, { ...DEFAULT_FILTER, time: 'yesterday' }, NOW).map((item) => item.appId)).toEqual(['budget'])
    expect(applyAppFilter(items, { ...DEFAULT_FILTER, time: 'older' }, NOW).map((item) => item.appId)).toEqual(['old'])
  })

  test('a facet that cuts works only does not hide an app', () => {
    // WHY: the filter is one object for every tab. A type or a pin facet left
    // from a works tab must not empty the Apps tab, which has no control to clear it.
    const worksOnly = { ...DEFAULT_FILTER, type: 'doc' as const, pinnedOnly: true, awaitingMyReview: true }
    expect(applyAppFilter(items, worksOnly, NOW)).toHaveLength(3)
  })

  test('the facet menus count the apps each choice holds', () => {
    expect(appProjectOptions(items).map((option) => [option.label, option.count])).toEqual([['project money', 1], ['project notes', 2]])
    expect(appTimeCounts(items, NOW)).toEqual({ today: 1, yesterday: 1, week: 0, older: 1 })
  })

  test('the cards fall into the date buckets of the ledger, in the order they come in', () => {
    expect(groupAppItems(items, NOW).map((group) => [group.label, group.items.map((item) => item.appId)])).toEqual([
      ['Today', ['notes']],
      ['Yesterday', ['budget']],
      ['September', ['old']],
    ])
  })
})
