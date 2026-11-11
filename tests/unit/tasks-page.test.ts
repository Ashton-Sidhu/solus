import { describe, expect, test } from 'bun:test'
import type { TaskSourceState } from '@solus/contracts/task-types'
import {
  matchesTaskQuery,
  sourceNotices,
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

describe('the notices of the sources on screen', () => {
  test('a healthy source that the host read whole says nothing', () => {
    expect(sourceNotices([source('app')])).toEqual([])
  })

  test('each source that cannot be read, or is truncated, gets one line with its name', () => {
    // WHY: a project can mix sources. "Reconnect" alone does not say which
    // provider connection to repair.
    const notices = sourceNotices([
      source('app'),
      source('site', { health: 'reconnect', message: 'The GitHub connection cannot read Projects.' }),
      source('docs', { truncated: true }),
    ])

    expect(notices).toEqual([
      { sourceKey: 'github-repo:acme/site', tone: 'failure', text: 'acme/site: Reconnect. The GitHub connection cannot read Projects.' },
      { sourceKey: 'github-repo:acme/docs', tone: 'warning', text: 'acme/docs: Truncated. This source holds more tasks than Solus read. Search reaches the rest.' },
    ])
  })
})
