import { describe, expect, test } from 'bun:test'
import {
  plainSnippet,
  SNIPPET_HIT_CLOSE,
  SNIPPET_HIT_OPEN,
  snippetRuns,
  snippetWindow,
} from '@solus/contracts/search-snippet'

const mark = (word: string) => `${SNIPPET_HIT_OPEN}${word}${SNIPPET_HIT_CLOSE}`

describe('search snippets', () => {
  test('runs follow the index markers, so a stemmed hit is marked as the index matched it', () => {
    // WHY: a client re-matching by spelling missed "runs" for "running" and
    // marked the tail of "unauthorized" for "auth". The index knows which
    // tokens hit; the markers carry that knowledge to the row.
    expect(snippetRuns(`it ${mark('runs')} fine`)).toEqual([
      { text: 'it ', hit: false },
      { text: 'runs', hit: true },
      { text: ' fine', hit: false },
    ])
    expect(snippetRuns('plain')).toEqual([{ text: 'plain', hit: false }])
    expect(snippetRuns('')).toEqual([{ text: '', hit: false }])
  })

  test('a reader that cannot mark strips the markers rather than printing them', () => {
    expect(plainSnippet(`the ${mark('token')} expired`)).toBe('the token expired')
  })

  test('the window is cut around the first hit, on plain length, and keeps every mark inside it', () => {
    const lead = 'w '.repeat(60)
    const snippet = `${lead}the ${mark('pelican')} and the ${mark('heron')}${' t'.repeat(60)}`
    const window = snippetWindow(snippet, 10, 30)
    expect(window.startsWith('…')).toBe(true)
    expect(window.endsWith('…')).toBe(true)
    // Cut edges are trimmed so no stray gap sits against an ellipsis.
    expect(plainSnippet(window)).toBe('…w w w the pelican and the heron t t t t…')
    expect(window).toContain(mark('pelican'))
    expect(window).toContain(mark('heron'))
  })

  test('a window with no hit is the head of the snippet, unmarked', () => {
    expect(snippetWindow('a b c d', 1, 2)).toBe('a b')
  })
})
