import { describe, expect, test } from 'bun:test'
import {
  distinctFileCount,
  groupMatches,
  lineSegments,
  segmentStyle,
  visibleLine,
  type LineSegmentToken,
} from '../../src/renderer/components/search/lib/project-search'
import type { ProjectContentMatch } from '../../src/shared/types'

// A search result row is a promise about *where* the hit is. A highlight that
// lands one character off, or a selection index that skips a row, sends the
// user to the wrong place in a file they didn't write.

function match(overrides: Partial<ProjectContentMatch> = {}): ProjectContentMatch {
  return {
    path: 'src/a.ts',
    lineNumber: 1,
    lineContent: 'const total = 1',
    matchRanges: [{ start: 6, end: 11 }],
    ...overrides,
  }
}

function rendered(segments: ReturnType<typeof lineSegments>): string {
  return segments.map((s) => (s.isMatch ? `[${s.text}]` : s.text)).join('')
}

function plain(m: ProjectContentMatch) {
  return lineSegments(visibleLine(m))
}

describe('result line highlighting', () => {
  test('marks exactly the matched span', () => {
    expect(rendered(plain(match()))).toBe('const [total] = 1')
  })

  test('strips indentation and shifts the highlight with it', () => {
    // Deeply nested code would otherwise render as a row of blank space with
    // the actual hit truncated off the right edge.
    const segments = plain(
      match({ lineContent: '      const total = 1', matchRanges: [{ start: 12, end: 17 }] }),
    )
    expect(rendered(segments)).toBe('const [total] = 1')
  })

  test('merges overlapping ranges instead of emitting text twice', () => {
    const segments = plain(match({ matchRanges: [{ start: 6, end: 11 }, { start: 8, end: 13 }] }))
    expect(segments.map((s) => s.text).join('')).toBe('const total = 1')
    expect(rendered(segments)).toBe('const [total =] 1')
  })

  test('drops a range the engine reported past the end of the line', () => {
    const segments = plain(match({ matchRanges: [{ start: 6, end: 900 }] }))
    expect(segments.map((s) => s.text).join('')).toBe('const total = 1')
  })
})

describe('syntax tokens under a match', () => {
  // `const total = 1` as the highlighter sees it.
  const TOKENS: LineSegmentToken[] = [
    { content: 'const', offset: 0, color: '#ff7b72', fontStyle: 1 },
    { content: ' ', offset: 5 },
    { content: 'total', offset: 6, color: '#79c0ff' },
    { content: ' = ', offset: 11 },
    { content: '1', offset: 14, color: '#a5d6ff' },
  ]

  test('a match that covers a whole token keeps that token colour', () => {
    const segments = lineSegments(visibleLine(match()), TOKENS)
    expect(rendered(segments)).toBe('const [total] = 1')
    expect(segments.find((s) => s.isMatch)).toMatchObject({ text: 'total', color: '#79c0ff' })
  })

  test('a match starting mid-token splits it without losing the colour', () => {
    // A highlight that swallowed the token's colour would make matched code the
    // only uncoloured text on the row — exactly where the eye is going.
    const segments = lineSegments(
      visibleLine(match({ matchRanges: [{ start: 8, end: 13 }] })),
      TOKENS,
    )
    // A match spanning two tokens yields one marked run per token, so each
    // keeps its own colour; they render as one continuous highlight.
    expect(rendered(segments)).toBe('const to[tal][ =] 1')
    expect(segments.filter((s) => s.color === '#79c0ff').map((s) => s.text)).toEqual(['to', 'tal'])
  })

  test('the concatenated segments still reproduce the line exactly', () => {
    const segments = lineSegments(visibleLine(match()), TOKENS)
    expect(segments.map((s) => s.text).join('')).toBe('const total = 1')
  })

  test('no tokens renders the line as one uncoloured run per match boundary', () => {
    expect(plain(match()).every((s) => s.color === undefined)).toBe(true)
  })

  test('font style bits become inline declarations', () => {
    expect(segmentStyle({ text: 'const', isMatch: false, color: '#ff7b72', fontStyle: 3 }))
      .toBe('color:#ff7b72;font-style:italic;font-weight:700')
    expect(segmentStyle({ text: 'x', isMatch: false })).toBeUndefined()
  })
})

describe('result grouping', () => {
  test('indexes run across files so arrow keys cross group boundaries', () => {
    const groups = groupMatches([
      match({ path: 'src/a.ts', lineNumber: 4 }),
      match({ path: 'src/a.ts', lineNumber: 9 }),
      match({ path: 'src/b.ts', lineNumber: 2 }),
    ])
    expect(groups.map((group) => group.matches.map((m) => m.index))).toEqual([[0, 1], [2]])
  })

  test('indexes are offset by the already-rendered window', () => {
    // The list renders in windows; a later window's rows must keep the index
    // the flat selection uses, not restart from zero.
    const groups = groupMatches([match({ path: 'src/c.ts' })], 100)
    expect(groups[0].matches[0].index).toBe(100)
  })

  test('splits the header into file name and directory', () => {
    const [group] = groupMatches([match({ path: 'src/deep/a.ts' })])
    expect(group).toMatchObject({ name: 'a.ts', directory: 'src/deep' })
  })

  test('counts distinct files, not matches', () => {
    expect(
      distinctFileCount([
        match({ path: 'src/a.ts' }),
        match({ path: 'src/a.ts' }),
        match({ path: 'src/b.ts' }),
      ]),
    ).toBe(2)
  })
})
