import { describe, expect, test } from 'bun:test'
import { matchesSearch } from '@solus/workspace-ui/lib/search-match'

describe('list menu search', () => {
  test('a row matches when its label holds every word of the search', () => {
    // WHY: a fuzzy match ranked unrelated rows first. A word match lists only
    // rows that name what was typed, in any order.
    expect(matchesSearch('solus/verify-portable-session-cli', 'portable-session')).toBe(true)
    expect(matchesSearch('deps/sec-postcss', 'portable-session')).toBe(false)
    expect(matchesSearch('team/feature-4999', 'Team 4999')).toBe(true)
    expect(matchesSearch('main', '')).toBe(true)
  })
})
