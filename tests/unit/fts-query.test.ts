import { describe, expect, test } from 'bun:test'
import { sanitizeFtsQuery } from '@solus/server/db/fts'

describe('sanitizeFtsQuery', () => {
  test('quotes every token so typed FTS operators stay literal', () => {
    expect(sanitizeFtsQuery('auth OR "token"')).toBe('"auth" "OR" """token"""')
  })

  test('a blank query is no query', () => {
    expect(sanitizeFtsQuery('   ')).toBe('')
  })
})
