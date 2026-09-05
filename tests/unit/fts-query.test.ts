import { describe, expect, test } from 'bun:test'
import { sanitizeFtsQuery } from '@solus/server/db/fts'

describe('sanitizeFtsQuery', () => {
  test('quotes every token so typed FTS operators stay literal', () => {
    expect(sanitizeFtsQuery('auth OR "token"')).toBe('"auth" "OR" """token"""')
  })

  test('a query still being typed matches the last word as a prefix', () => {
    // The picker searches on every keystroke; "auth" must reach
    // "authentication" or nothing shows until the word is complete.
    expect(sanitizeFtsQuery('rate auth', { prefixLastToken: true })).toBe('"rate" "auth"*')
  })

  test('a blank query is no query, prefix or not', () => {
    expect(sanitizeFtsQuery('   ', { prefixLastToken: true })).toBe('')
  })
})
