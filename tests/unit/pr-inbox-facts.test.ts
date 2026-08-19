import { describe, expect, test } from 'bun:test'
import type { PullRequestSummary } from '@solus/contracts/providers'
import { prInboxFacts } from '@solus/workspace-ui/components/prs/lib/pr-utils'
import type { ReviewEffort } from '@solus/contracts/effort-types'

const NOW = Date.parse('2026-01-01T12:00:00Z')

function pr(number: number, state: PullRequestSummary['state'], effort?: ReviewEffort): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    headSha: `head-${number}`,
    author: 'sidhu',
    authorAvatarUrl: '',
    state,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    effort,
  }
}

// The masthead states three facts as plain assertions with no qualifiers, so
// each one has to be true of the data actually loaded — a wrong count here is a
// wrong claim, not a cosmetic slip.
describe('prInboxFacts', () => {
  test('counts only open PRs, so the Closed and All fetches never inflate "N open"', () => {
    const items = [pr(1, 'open'), pr(2, 'closed'), pr(3, 'merged'), pr(4, 'open')]

    expect(prInboxFacts({ items, filtered: items, listLoadedAt: NOW, now: NOW }).openCount).toBe(2)
  })

  test('omits the effort fact when no PR has an estimate rather than claiming zero minutes', () => {
    const items = [pr(1, 'open'), pr(2, 'open')]

    expect(prInboxFacts({ items, filtered: items, listLoadedAt: NOW, now: NOW }).effortMinutes).toBeNull()
  })

  test('sums review minutes over the rows on screen, not the whole fetch', () => {
    const items = [
      pr(1, 'open', { band: 'quick', minutes: 4, signals: ['tiny'] }),
      pr(2, 'open', { band: 'involved', minutes: 38, signals: ['large'] }),
    ]

    expect(prInboxFacts({ items, filtered: [items[1]!], listLoadedAt: NOW, now: NOW }).effortMinutes).toBe(38)
  })

  test('has no synced label before the first load lands', () => {
    expect(prInboxFacts({ items: [], filtered: [], listLoadedAt: 0, now: NOW }).syncedLabel).toBeNull()
  })

  test('ages the synced label from the load stamp', () => {
    const facts = prInboxFacts({
      items: [],
      filtered: [],
      listLoadedAt: NOW - 2 * 60_000,
      now: NOW,
    })

    expect(facts.syncedLabel).toBe('Synced 2m ago')
  })
})
