import { describe, expect, test } from 'bun:test'
import { pullRequestFixture } from './__fixtures__/pull-request'
import {
  readPrListPreferences,
  readPrListSnapshot,
  writePrListPreferences,
  writePrListSnapshot,
} from '@solus/workspace-ui/components/prs/lib/pr-list-memory'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }
}

const NOW = Date.parse('2026-09-22T12:00:00Z')

describe('remembered pull request list', () => {
  test('a reload paints the last unsearched list for the same scope', () => {
    // WHY: without it every revisit cold-starts into a skeleton even though
    // almost every row is unchanged; the live read then replaces it in place.
    const storage = memoryStorage()
    const rows = [pullRequestFixture(1, { title: 'Fold the header', body: 'long body' }), pullRequestFixture(2)]
    writePrListSnapshot('all', { state: 'open', savedAt: NOW, projects: [{ serverId: 'local', projectRoot: '/repo', items: rows }] }, storage)

    const snapshot = readPrListSnapshot('all', 'open', NOW + 60_000, storage)
    expect(snapshot?.projects[0]?.items.map((item) => [item.number, item.title])).toEqual([[1, 'Fold the header'], [2, 'PR 2']])
    // The one unbounded field is not carried.
    expect(snapshot?.projects[0]?.items[0]?.body).toBe('')
    expect(readPrListSnapshot('local::/other', 'open', NOW, storage)).toBeNull()
  })

  test('is bounded, and refuses rows read under another state, too old, or malformed', () => {
    // WHY: a merged row must never sit under Open for the round trip, a week-old
    // list misleads more than it helps, and storage written by an older build
    // must not break the page on every reload.
    const storage = memoryStorage()
    const many = Array.from({ length: 150 }, (_, index) => pullRequestFixture(index + 1))
    writePrListSnapshot('all', { state: 'open', savedAt: NOW, projects: [
      { serverId: 'a', projectRoot: '/a', items: many.slice(0, 80) },
      { serverId: 'b', projectRoot: '/b', items: many.slice(80) },
    ] }, storage)
    const snapshot = readPrListSnapshot('all', 'open', NOW, storage)
    expect(snapshot?.projects.reduce((count, project) => count + project.items.length, 0)).toBe(99)

    expect(readPrListSnapshot('all', 'closed', NOW, storage)).toBeNull()
    expect(readPrListSnapshot('all', 'open', NOW + 8 * 24 * 60 * 60_000, storage)).toBeNull()
    storage.values.set('solus.prs.list:all', JSON.stringify({ version: 1, state: 'open', savedAt: NOW, projects: [{ serverId: 'a', projectRoot: '/a', items: [{ number: 'one' }] }] }))
    expect(readPrListSnapshot('all', 'open', NOW, storage)).toBeNull()
    storage.values.set('solus.prs.list:all', '{not json')
    expect(readPrListSnapshot('all', 'open', NOW, storage)).toBeNull()
  })
})

describe('remembered list preferences', () => {
  test('the sort and filters chosen on this device come back, and a stale shape is dropped whole', () => {
    // WHY: the reader's queue should open the way they left it; a preference
    // from an older build is ignored rather than half-applied.
    const storage = memoryStorage()
    const preferences = {
      sortMode: 'updated' as const,
      statusKeys: ['merged'],
      involvement: 'review-requested' as const,
      author: 'alex',
      label: null,
      draft: 'ready' as const,
      review: 'all' as const,
      checks: 'failing' as const,
      guide: 'all' as const,
    }
    writePrListPreferences(preferences, storage)
    expect(readPrListPreferences(storage)).toEqual(preferences)

    storage.values.set('solus.prs.preferences', JSON.stringify({ ...preferences, sortMode: 'size' }))
    expect(readPrListPreferences(storage)).toBeNull()
  })
})
