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

  test('punctuation separates indexed words and is never interpreted as a regex', () => {
    expect(highlightWordRuns('a+b and c', 'a+b')).toEqual([
      { text: 'a', hit: true },
      { text: '+', hit: false },
      { text: 'b', hit: true },
      { text: ' ', hit: false },
      { text: 'a', hit: true },
      { text: 'nd c', hit: false },
    ])
  })

  test('coding boundaries and accent folding use source positions', () => {
    expect(highlightWordRuns('serverConnections Café', 'connections cafe')).toEqual([
      { text: 'server', hit: false }, { text: 'Connections', hit: true },
      { text: ' ', hit: false }, { text: 'Café', hit: true },
    ])
  })

  test('a blank query is one unmarked run', () => {
    expect(highlightWordRuns('plain', '  ')).toEqual([{ text: 'plain', hit: false }])
  })
})
