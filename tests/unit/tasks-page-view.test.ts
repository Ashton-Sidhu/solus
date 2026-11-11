import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test'
import type { Task, TaskSourceState } from '@solus/contracts/task-types'
import { NO_COLUMN_ID } from '@solus/workspace-ui/components/tasks/lib/tasks-api'
import { SvelteRunes } from './helpers/svelte-runes'

// The Tasks page view and its provider search run on Svelte's runtime here:
// their answers are `$derived` and must follow the source on screen.

type TasksPageViewClass = typeof import('@solus/workspace-ui/components/tasks/tasks-page-view.svelte')['TasksPageView']
type ProviderTaskSearchClass = typeof import('@solus/workspace-ui/components/tasks/lib/provider-search.svelte')['ProviderTaskSearch']
type PageTask = Parameters<ConstructorParameters<TasksPageViewClass>[0]['tasks']> extends [] ? ReturnType<ConstructorParameters<TasksPageViewClass>[0]['tasks']>[number] : never

const runes = new SvelteRunes()
afterAll(() => runes.dispose())
afterEach(() => jest.useRealTimers())

const file = SvelteRunes.file
const tasksDirectory = 'packages/workspace-ui/src/components/tasks'
const viewModule = runes.source('tasks-page-view', `${tasksDirectory}/tasks-page-view.svelte.ts`, {
  './lib/tasks-api': file(`${tasksDirectory}/lib/tasks-api.ts`),
  './lib/tasks-list-view': file(`${tasksDirectory}/lib/tasks-list-view.ts`),
  './lib/tasks-page': file(`${tasksDirectory}/lib/tasks-page.ts`),
})
const searchModule = runes.source('provider-search', `${tasksDirectory}/lib/provider-search.svelte.ts`)
const { TasksPageView } = await import(viewModule) as { TasksPageView: TasksPageViewClass }
const { ProviderTaskSearch } = await import(searchModule) as { ProviderTaskSearch: ProviderTaskSearchClass }

const NOW = Date.parse('2026-08-04T13:00:00Z')
const REPO = 'github-repo:acme/app'
const BOARD = 'github-project:acme/7'

const repo: TaskSourceState = {
  sourceKey: REPO,
  source: { kind: 'github-repo', owner: 'acme', repo: 'app' },
  label: 'acme/app',
  columns: [
    { id: 'open', name: 'Open', category: 'open' },
    { id: 'closed', name: 'Closed', category: 'done' },
  ],
  health: 'ok',
  fetchedAt: NOW - 60_000,
}
const board: TaskSourceState = {
  sourceKey: BOARD,
  source: { kind: 'github-project', owner: 'acme', number: 7 },
  label: 'Roadmap',
  columns: [
    { id: 'opt-todo', name: 'Backlog', category: 'open' },
    { id: 'opt-doing', name: 'Building', category: 'active' },
    { id: 'opt-done', name: 'Shipped', category: 'done' },
  ],
  health: 'ok',
  fetchedAt: NOW - 30_000,
}

function task(id: string, fields: Partial<Task>): Task {
  return {
    id,
    providerId: 'github',
    kind: 'issue',
    reference: `acme/app#${id}`,
    title: `Task ${id}`,
    body: '',
    url: null,
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: [],
    labels: [],
    writableFields: [],
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...fields,
  }
}

// One repository issue, one issue on both sources, one finished board item,
// and one new board item that has no column yet.
const repoOnly = task('repo-only', { title: 'Fix the payment retry', placements: [{ sourceKey: REPO, columnId: 'open' }] })
const onBoth = task('on-both', {
  category: 'active',
  assignee: 'octocat',
  placements: [{ sourceKey: REPO, columnId: 'open' }, { sourceKey: BOARD, columnId: 'opt-doing' }],
})
const shipped = task('shipped', { category: 'done', placements: [{ sourceKey: BOARD, columnId: 'opt-done' }] })
const noColumn = task('no-column', { kind: 'draft', reference: undefined, placements: [{ sourceKey: BOARD, columnId: null }] })
const projectTasks = [repoOnly, onBoth, shipped, noColumn]

interface Scene {
  tasks?: Task[]
  sources?: TaskSourceState[]
  running?: string[]
  showsEveryProject?: boolean
  homes?: Map<string, string>
}

function scene(options: Scene = {}) {
  const searches: string[] = []
  const answers = new Map<string, PromiseWithResolvers<Task[]>>()
  const providerSearch = new ProviderTaskSearch({
    // SAFETY: the search reads only `search` of the store.
    search: (_serverId: string, _cwd: string, query: string) => {
      searches.push(query)
      const answer = Promise.withResolvers<Task[]>()
      answers.set(query, answer)
      return answer.promise
    },
  } as unknown as ConstructorParameters<ProviderTaskSearchClass>[0])
  const view = new TasksPageView({
    // SAFETY: the view reads the record fields of a task and `snoozedUntil`.
    tasks: () => (options.tasks ?? projectTasks) as unknown as PageTask[],
    sources: () => options.sources ?? [repo, board],
    now: () => NOW,
    runningSessionsFor: (taskId) => (options.running?.includes(taskId) ? 1 : 0),
    projectLabelFor: () => 'acme/app',
    homeFor: (taskId) => options.homes?.get(taskId) ?? null,
    showsEveryProject: () => options.showsEveryProject ?? false,
    providerSearch,
  })
  return { view, providerSearch, searches, answers }
}

const sections = (view: InstanceType<TasksPageViewClass>) => view.groups.map((group) => [group.label, group.rows.map((row) => row.key)])
const cards = (view: InstanceType<TasksPageViewClass>) => view.columns.map((column) => [column.label, column.tasks.map((row) => row.id)])
const flush = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve() }

describe('all sources of the project', () => {
  test('is what the page opens on, grouped by status category, each task once', () => {
    // WHY: columns of two sources do not line up, so the mixed view groups by
    // the status category (plan §7). The issue on both sources is one row.
    const { view } = scene()

    expect(view.source).toBeNull()
    expect(view.board).toEqual({ kind: 'all' })
    expect(cards(view)).toEqual([
      ['Open', ['repo-only', 'no-column']],
      ['Active', ['on-both']],
      ['Done', ['shipped']],
    ])
  })

  test('the list hides finished work by default, and one pick shows it', () => {
    // WHY: closed work is the record of what shipped. It stays reachable, but
    // it is never what the page opens on.
    const { view } = scene()

    expect(view.columnIds).toEqual(['open', 'active'])
    expect(sections(view)).toEqual([
      ['Open', ['repo-only', 'no-column']],
      ['Active', ['on-both']],
    ])
    expect(view.flatVisibleIds).toEqual(['repo-only', 'no-column', 'on-both'])
    // The option still shows how many tasks the hidden column holds.
    expect(view.columnOptions).toEqual([
      { value: 'open', label: 'Open', count: 2 },
      { value: 'active', label: 'Active', count: 1 },
      { value: 'done', label: 'Done', count: 1 },
    ])

    view.selectedColumnIds = ['done']
    expect(sections(view)).toEqual([['Done', ['shipped']]])
  })

  test('the board ignores the column filter', () => {
    // WHY: the columns of a board are this filter. A kanban whose last column
    // is always empty reads as broken.
    const { view } = scene()
    view.layout = 'board'
    expect(view.visibleTasks.map((row) => row.id).sort()).toEqual(['no-column', 'on-both', 'repo-only', 'shipped'])

    view.selectedColumnIds = ['open']
    expect(view.visibleTasks).toHaveLength(4)
  })

  test('a task can be moved to each status category', () => {
    const { view } = scene()
    expect(view.moveOptions.map((column) => column.id)).toEqual(['open', 'active', 'done'])
  })
})

describe('one source on screen', () => {
  test('shows the tasks that the source lists, in the columns of the provider', () => {
    // WHY: a board shows the provider's columns as they are (decision 7). A
    // repository issue that is not on the board must not show on it.
    const { view } = scene()
    view.showSource(BOARD)

    expect(view.source?.label).toBe('Roadmap')
    expect(view.board).toEqual({ kind: 'source', source: board })
    expect(view.searched.map((row) => row.id)).toEqual(['on-both', 'shipped', 'no-column'])
    expect(cards(view)).toEqual([
      ['No column', ['no-column']],
      ['Backlog', []],
      ['Building', ['on-both']],
      ['Shipped', ['shipped']],
    ])
  })

  test('a task on two sources shows with the column of the source on screen', () => {
    const { view } = scene()
    view.showSource(REPO)
    expect(sections(view)).toEqual([['Open', ['repo-only', 'on-both']]])

    view.showSource(BOARD)
    expect(sections(view)).toEqual([['No column', ['no-column']], ['Building', ['on-both']]])
  })

  test('the list opens on the columns that are not done, with the items that have no column', () => {
    // WHY: a new board item has no column yet and is the newest work. The
    // default filter follows the status category of each provider column.
    const { view } = scene()
    view.showSource(BOARD)

    expect(view.columnIds).toEqual([NO_COLUMN_ID, 'opt-todo', 'opt-doing'])
    expect(view.flatVisibleIds).toEqual(['no-column', 'on-both'])
  })

  test('a column filter does not survive a change of source', () => {
    // WHY: the filter holds column ids of one view. On another view those ids
    // match nothing, and the page would show an empty list with no visible cause.
    const { view } = scene()
    view.showSource(BOARD)
    view.selectedColumnIds = ['opt-done']
    expect(sections(view)).toEqual([['Shipped', ['shipped']]])

    view.showSource(REPO)
    expect(view.selectedColumnIds).toBeNull()
    expect(view.columnIds).toEqual(['open'])

    view.showSource(null)
    expect(view.board).toEqual({ kind: 'all' })
    expect(view.columnIds).toEqual(['open', 'active'])
  })

  test('nothing can be moved to "No column"', () => {
    // WHY: no provider has that column, so the bulk bar must not offer it.
    const { view } = scene()
    view.showSource(BOARD)
    expect(view.moveOptions.map((column) => column.label)).toEqual(['Backlog', 'Building', 'Shipped'])
  })

  test('a source that the project no longer lists falls back to all sources', () => {
    // WHY: a person can remove the source on screen in the source setup. The
    // page must not stay on a view of a source that is gone.
    const { view } = scene({ sources: [repo] })
    view.showSource(BOARD)
    expect(view.source).toBeNull()
    expect(view.board).toEqual({ kind: 'all' })
  })

  test('the notices and the freshness are those of the source on screen', () => {
    // WHY: a broken board must not put its warning on the view of the
    // repository, which is read and complete.
    const brokenBoard: TaskSourceState = { ...board, health: 'reconnect', truncated: true, fetchedAt: NOW - 3_600_000 }
    const { view } = scene({ sources: [repo, brokenBoard] })

    expect(view.notices.map((notice) => notice.sourceKey)).toEqual([BOARD])
    expect(view.syncState).toEqual({ syncedAt: NOW - 3_600_000, fromCache: true })
    expect(view.truncated).toBe(true)

    view.showSource(REPO)
    expect(view.notices).toEqual([])
    expect(view.syncState).toEqual({ syncedAt: NOW - 60_000, fromCache: false })
    expect(view.truncated).toBe(false)
    expect(view.truncationNote).toBeNull()
  })
})

describe('the filters', () => {
  test('the search keeps the tasks that match, in each layout', () => {
    const { view } = scene()
    view.query = 'payment'
    expect(view.flatVisibleIds).toEqual(['repo-only'])
    view.layout = 'board'
    expect(view.visibleTasks.map((row) => row.id)).toEqual(['repo-only'])
  })

  test('a snoozed task is out of the list until the Snoozed filter asks for it', () => {
    // WHY: a snooze hides the task from the reader's lists. The Snoozed
    // filter is the way back to it.
    const sleeping = { ...repoOnly, snoozedUntil: NOW + 60_000 }
    const { view } = scene({ tasks: [sleeping, onBoth] })

    expect(view.flatVisibleIds).toEqual(['on-both'])
    expect(view.filterCounts.snoozed).toBe(1)

    view.snoozedOnly = true
    expect(view.flatVisibleIds).toEqual(['repo-only'])
  })

  test('each chip counts what it would show, and narrows the list when on', () => {
    const overdue = { ...repoOnly, dueDate: '2026-08-01' }
    const doneAndPastDue = { ...shipped, dueDate: '2026-08-01' }
    const { view } = scene({ tasks: [overdue, onBoth, doneAndPastDue], running: ['on-both'] })

    // A finished task is not overdue.
    expect(view.filterCounts).toEqual({ running: 1, overdue: 1, assigned: 1, snoozed: 0 })

    view.runningOnly = true
    expect(view.flatVisibleIds).toEqual(['on-both'])
    view.runningOnly = false
    view.overdueOnly = true
    expect(view.flatVisibleIds).toEqual(['repo-only'])
    view.overdueOnly = false
    view.assignedOnly = true
    expect(view.flatVisibleIds).toEqual(['on-both'])
  })

  test('the manual order of the board applies only when no filter narrows it', () => {
    // WHY: a drag renumbers the cards of a column. With a filter on, the
    // column on screen is not the whole column, so the numbers would be wrong.
    // The column filter does not count: the board ignores it.
    const { view } = scene()
    expect(view.boardUnfiltered).toBe(true)
    view.selectedColumnIds = ['done']
    expect(view.boardUnfiltered).toBe(true)
    view.query = 'payment'
    expect(view.boardUnfiltered).toBe(false)
    view.clearFilters()
    expect(view.boardUnfiltered).toBe(true)
    expect(view.selectedColumnIds).toBeNull()
  })

  test('Clear filters in the menu keeps the search text', () => {
    // WHY: the Filters badge does not count the search, so its Clear must not
    // empty the search box.
    const { view } = scene()
    view.query = 'payment'
    view.assignedOnly = true
    view.clearMenuFilters()
    expect(view.query).toBe('payment')
    expect(view.assignedOnly).toBe(false)
  })
})

describe('where a row says it lives', () => {
  test('one project on one machine draws no place column', () => {
    const { view } = scene()
    expect(view.groups.flatMap((group) => group.rows).every((row) => row.place === undefined)).toBe(true)
  })

  test('every project, or a task read by another host, gives each row the cell', () => {
    // WHY: the list is a table. Each row has the cell or none has it.
    const everyProject = scene({ showsEveryProject: true }).view
    expect(everyProject.groups[0].rows.map((row) => row.place)).toEqual([
      { project: 'acme/app', host: null },
      { project: 'acme/app', host: null },
    ])

    const remote = scene({ homes: new Map([['on-both', 'Workshop']]) }).view
    expect(remote.groups.flatMap((group) => group.rows).map((row) => row.place?.host ?? null)).toEqual([null, null, 'Workshop'])
  })
})

describe('search of the provider', () => {
  const truncatedRepo: TaskSourceState = { ...repo, truncated: true }
  const fromProvider = task('found-by-github', { title: 'Old payment bug', placements: [{ sourceKey: REPO, columnId: 'open' }] })

  test('asks the provider after a pause in typing, once for the last text', async () => {
    // WHY: this is a keystroke handler and the far end is a network search on
    // the person's GitHub or Jira rate limit.
    jest.useFakeTimers()
    const { providerSearch, searches } = scene()

    providerSearch.request('local', '/work/app', 'pay')
    jest.advanceTimersByTime(200)
    providerSearch.request('local', '/work/app', ' payment ')
    expect(providerSearch.searching).toBe(true)
    jest.advanceTimersByTime(349)
    expect(searches).toEqual([])
    jest.advanceTimersByTime(1)

    expect(searches).toEqual(['payment'])
  })

  test('the matches of the provider join the list only for the text they answer', async () => {
    // WHY: a truncated source did not list every task. The answer for an
    // earlier text must not show under the text now in the box.
    jest.useFakeTimers()
    const { view, providerSearch, answers } = scene({ sources: [truncatedRepo, board] })
    view.query = 'payment'
    expect(view.truncationNote).toBe('not every task is loaded · search reaches the rest')

    providerSearch.request('local', '/work/app', view.query)
    expect(view.truncationNote).toBe('searching the provider…')
    jest.advanceTimersByTime(350)
    answers.get('payment')?.resolve([fromProvider, repoOnly])
    await flush()

    expect(view.truncationNote).toBe('searched the provider')
    // The listed match shows once; the match of the provider follows it.
    expect(view.flatVisibleIds).toEqual(['repo-only', 'found-by-github'])

    view.query = 'payment retry'
    expect(view.flatVisibleIds).toEqual(['repo-only'])
    expect(view.truncationNote).toBe('not every task is loaded · search reaches the rest')
  })

  test('a source view does not show a match that the source does not list', async () => {
    jest.useFakeTimers()
    const { view, providerSearch, answers } = scene({ sources: [truncatedRepo, board] })
    view.showSource(BOARD)
    view.query = 'payment'
    providerSearch.request('local', '/work/app', view.query)
    jest.advanceTimersByTime(350)
    answers.get('payment')?.resolve([fromProvider])
    await flush()

    expect(view.searched).toEqual([])
  })

  test('an older answer never replaces a newer one', async () => {
    // WHY: the provider answers in any order. The slow answer for "pay" must
    // not replace the answer for "payment".
    jest.useFakeTimers()
    const { providerSearch, answers } = scene()
    providerSearch.request('local', '/work/app', 'pay')
    jest.advanceTimersByTime(350)
    providerSearch.request('local', '/work/app', 'payment')
    jest.advanceTimersByTime(350)

    answers.get('payment')?.resolve([fromProvider])
    await flush()
    answers.get('pay')?.resolve([repoOnly])
    await flush()

    expect(providerSearch.query).toBe('payment')
    expect(providerSearch.results.map((row) => row.id)).toEqual(['found-by-github'])
    expect(providerSearch.searching).toBe(false)
  })

  test('a provider that does not answer is reported, and the listed matches stay', async () => {
    // WHY: the list still answers "of the tasks the host read". The page must
    // say that the provider did not answer, not show a search that never ends.
    jest.useFakeTimers()
    const { view, providerSearch, answers, searches } = scene({ sources: [truncatedRepo, board] })
    view.query = 'payment'
    providerSearch.request('local', '/work/app', view.query)
    jest.advanceTimersByTime(350)
    answers.get('payment')?.reject(new Error('GitHub rate limit'))
    await flush()

    expect(providerSearch.error).toBe('GitHub rate limit')
    expect(providerSearch.searching).toBe(false)
    expect(view.truncationNote).toBe('the provider did not answer the search')
    expect(view.flatVisibleIds).toEqual(['repo-only'])

    // A text that the provider failed to answer is not asked again until it
    // changes: a re-render with the same text must not repeat a failing call.
    providerSearch.request('local', '/work/app', 'payment')
    jest.advanceTimersByTime(350)
    expect(searches).toEqual(['payment'])
    expect(providerSearch.error).toBe('GitHub rate limit')
  })

  test('a text back at the one already answered drops the request in flight', async () => {
    // WHY: the person typed one more letter and removed it. The answer on
    // screen is correct for the text in the box, so nothing must replace it
    // and the page must not show a search that runs.
    jest.useFakeTimers()
    const { providerSearch, answers, searches } = scene()
    providerSearch.request('local', '/work/app', 'payment')
    jest.advanceTimersByTime(350)
    answers.get('payment')?.resolve([fromProvider])
    await flush()

    providerSearch.request('local', '/work/app', 'payments')
    expect(providerSearch.searching).toBe(true)
    providerSearch.request('local', '/work/app', 'payment')
    jest.advanceTimersByTime(350)

    expect(searches).toEqual(['payment'])
    expect(providerSearch.searching).toBe(false)
    expect(providerSearch.results.map((row) => row.id)).toEqual(['found-by-github'])
  })

  test('an empty search box forgets the search, also one that waits for its answer', async () => {
    jest.useFakeTimers()
    const { providerSearch, answers, searches } = scene()
    providerSearch.request('local', '/work/app', 'payment')
    jest.advanceTimersByTime(350)
    providerSearch.request('local', '/work/app', '   ')
    answers.get('payment')?.resolve([fromProvider])
    await flush()

    expect(providerSearch.results).toEqual([])
    expect(providerSearch.query).toBe('')
    expect(providerSearch.searching).toBe(false)

    // A text that was typed and removed before the pause ended is not sent.
    providerSearch.request('local', '/work/app', 'refund')
    providerSearch.request('local', '/work/app', '')
    jest.advanceTimersByTime(350)
    expect(searches).toEqual(['payment'])
  })
})
