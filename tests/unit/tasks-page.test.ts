import { describe, expect, test } from 'bun:test'
import type { TaskSourceState } from '@solus/contracts/task-types'
import {
  matchesTaskQuery,
  sourcesFailure,
  sourcesSyncState,
  withProviderMatches,
} from '@solus/workspace-ui/components/tasks/lib/tasks-page'

function source(label: string, overrides: Partial<TaskSourceState> = {}): TaskSourceState {
  return {
    sourceKey: `github-repo:acme/${label}`,
    source: { kind: 'github-repo', owner: 'acme', repo: label },
    label: `acme/${label}`,
    columns: [],
    health: 'ok',
    fetchedAt: 1_000,
    ...overrides,
  }
}

describe('what the search box matches', () => {
  const task = { title: 'Fix the payment retry', reference: 'acme/app#412', labels: ['Billing', 'bug'] }

  test('matches the title, the reference and the labels, in any case', () => {
    // WHY: a person pastes `#412` or `SOL-12` as often as they type a word of
    // the title, and a label is how a team names an area of work.
    expect(matchesTaskQuery(task, 'PAYMENT')).toBe(true)
    expect(matchesTaskQuery(task, '#412')).toBe(true)
    expect(matchesTaskQuery(task, 'acme/app')).toBe(true)
    expect(matchesTaskQuery(task, 'billing')).toBe(true)
    expect(matchesTaskQuery(task, 'refund')).toBe(false)
  })

  test('an empty search box keeps every task', () => {
    expect(matchesTaskQuery(task, '   ')).toBe(true)
  })

  test('a draft item, which has no reference, still matches by its title', () => {
    // WHY: the missing reference must not put the word "undefined" in the text.
    const draft = { title: 'Sketch the onboarding', reference: undefined, labels: [] }
    expect(matchesTaskQuery(draft, 'onboarding')).toBe(true)
    expect(matchesTaskQuery(draft, 'undefined')).toBe(false)
  })
})

describe('what a search shows', () => {
  test('the listed matches first, then the tasks that only the provider found, each once', () => {
    // WHY: a truncated source did not list every task, so a match can come
    // from the provider alone. A task that the list and the provider both
    // have is one task: two rows with one key break the keyed list.
    const listed = [{ id: 'github:I_1' }, { id: 'github:I_2' }]
    const fromProvider = [{ id: 'github:I_2' }, { id: 'github:I_900' }]

    expect(withProviderMatches(listed, fromProvider).map((task) => task.id)).toEqual(['github:I_1', 'github:I_2', 'github:I_900'])
    // The listed task is the one that stays: it is the object the list drew.
    expect(withProviderMatches(listed, fromProvider)[1]).toBe(listed[1])
  })

  test('with no answer of the provider, the listed matches are the result', () => {
    const listed = [{ id: 'github:I_1' }]
    expect(withProviderMatches(listed, [])).toEqual(listed)
  })
})

describe('how fresh the tasks on screen are', () => {
  test('the page is only as fresh as its oldest source', () => {
    // WHY: "updated 1m ago" must not hide a source that the host read an hour ago.
    expect(sourcesSyncState([source('app', { fetchedAt: 5_000 }), source('site', { fetchedAt: 2_000 })]))
      .toEqual({ syncedAt: 2_000, fromCache: false })
  })

  test('a source that cannot be read now, but was read before, shows an old copy', () => {
    // WHY: the provider is the truth. When it does not answer, the page must
    // say that the tasks are the host's last copy.
    expect(sourcesSyncState([source('app'), source('site', { health: 'error', fetchedAt: 500 })]))
      .toEqual({ syncedAt: 500, fromCache: true })
  })

  test('a source that was never read holds no copy and no read time', () => {
    // WHY: a source that is not connected has no tasks on screen, so there is
    // nothing old to warn about. The source notice says why it is empty.
    expect(sourcesSyncState([source('app', { health: 'not_connected', fetchedAt: undefined })]))
      .toEqual({ syncedAt: null, fromCache: false })
    expect(sourcesSyncState([])).toEqual({ syncedAt: null, fromCache: false })
  })
})

describe('what the page says when task sources cannot be read', () => {
  test('healthy sources, and a source that is only truncated, are no failure', () => {
    // WHY: a truncated source is read; the filter bar says that search reaches
    // the rest. Only a source that cannot be read takes the page or a toast.
    expect(sourcesFailure([source('app'), source('docs', { truncated: true })])).toBeNull()
  })

  test('a GitHub source that needs a connection asks to connect GitHub, and names the source', () => {
    // WHY: the repair of a missing or weak connection is to connect the
    // provider. "Couldn't load tasks" with Retry would send the person around
    // in a circle.
    const failure = sourcesFailure([
      source('app'),
      source('site', { health: 'reconnect', message: 'The GitHub connection cannot read Projects.' }),
    ])

    expect(failure).toMatchObject({
      kind: 'github-auth',
      title: 'Connect GitHub to load tasks.',
      detail: 'acme/site: The GitHub connection cannot read Projects.',
    })
  })

  test('a Jira source that needs a connection asks to connect Atlassian', () => {
    const jira = source('board', {
      sourceKey: 'jira-board:site/12',
      source: { kind: 'jira-board', cloudId: 'site', boardId: 12 },
      label: 'ACME board',
      health: 'not_connected',
    })
    expect(sourcesFailure([jira])?.kind).toBe('jira-auth')
  })

  test('a source that GitHub refused or that failed is a plain failure, with Retry', () => {
    expect(sourcesFailure([source('app', { health: 'no_access', message: 'No access.' })]))
      .toMatchObject({ kind: 'generic', title: 'Couldn’t load tasks.' })
  })

  test('several failed sources are named in one sentence', () => {
    const failure = sourcesFailure([source('app', { health: 'error' }), source('site', { health: 'no_access' })])
    expect(failure?.detail).toBe('2 task sources cannot be read: acme/app, acme/site.')
  })

  test('the same failure keeps its key, and a new way to fail changes it', () => {
    // WHY: while tasks show, a failure is said in a toast. The same failure on
    // each read must not toast again; a new one must.
    const first = sourcesFailure([source('app', { health: 'error' })])
    const again = sourcesFailure([source('app', { health: 'error', message: 'Timeout.' })])
    const worse = sourcesFailure([source('app', { health: 'reconnect' })])
    expect(again?.key).toBe(first?.key)
    expect(worse?.key).not.toBe(first?.key)
  })
})
