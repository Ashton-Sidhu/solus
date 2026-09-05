import { describe, expect, test } from 'bun:test'
import { highlightRuns, highlightWordRuns } from '@solus/workspace-ui/lib/searchHighlight'

describe('highlightWordRuns', () => {
  test('marks each word of the query on its own, wherever it falls', () => {
    // WHY: a full-text hit ANDs the words; they need not be adjacent, so the
    // phrase matcher would mark nothing in a passage that plainly matched.
    expect(highlightRuns('limit the rate of calls', 'rate limit')).toEqual([
      { text: 'limit the rate of calls', hit: false },
    ])
    expect(highlightWordRuns('limit the rate of calls', 'rate limit')).toEqual([
      { text: 'limit', hit: true },
      { text: ' the ', hit: false },
      { text: 'rate', hit: true },
      { text: ' of calls', hit: false },
    ])
  })

  test('a typed regex character is a literal', () => {
    expect(highlightWordRuns('a+b and c', 'a+b')).toEqual([
      { text: 'a+b', hit: true },
      { text: ' and c', hit: false },
    ])
  })

  test('a blank query is one unmarked run', () => {
    expect(highlightWordRuns('plain', '  ')).toEqual([{ text: 'plain', hit: false }])
  })
})
