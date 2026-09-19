import { describe, expect, test } from 'bun:test'
import type { TaskPrSnapshot } from '@solus/contracts/task-types'
import { latestPrObservation, prChipForChoices } from '@solus/workspace-ui/components/session/lib/task-list'
import { samePrLinks } from '@solus/workspace-ui/contexts/tasks/task-reconcile'
import { pullRequestFixture } from './__fixtures__/pull-request'

const snapshot: TaskPrSnapshot = {
  number: 12, url: 'https://github.com/acme/repo/pull/12', title: 'Saved title',
  state: 'merged', draft: false, updatedAt: '2026-09-16T20:00:00Z',
  baseRepo: { host: 'github.com', owner: 'acme', repo: 'repo' },
}

describe('sidebar saved PR observations', () => {
  test('renders a state badge with only a compact saved summary', () => {
    expect(prChipForChoices([{
      number: 12, targetScope: 'github.com/acme/repo', title: snapshot.title,
      url: snapshot.url, pullRequest: latestPrObservation(undefined, snapshot),
    }])).toEqual({ number: 12, count: 1, state: 'merged' })
  })

  test('an older renderer cache cannot overwrite the host snapshot', () => {
    const live = pullRequestFixture(12, { state: 'open', updatedAt: '2026-09-16T19:00:00Z' })
    expect(latestPrObservation(live, snapshot)).toBe(snapshot)
    live.updatedAt = '2026-09-16T21:00:00Z'
    expect(latestPrObservation(live, snapshot)).toBe(live)
  })

  test('task invalidation applies changed observations without changing the link identity', () => {
    const link = { number: 12, snapshot }
    expect(samePrLinks([link], [{ ...link, snapshot: { ...snapshot } }])).toBe(true)
    expect(samePrLinks([link], [{ ...link, snapshot: { ...snapshot, updatedAt: '2026-09-16T21:00:00Z', state: 'open' } }])).toBe(false)
  })
})
