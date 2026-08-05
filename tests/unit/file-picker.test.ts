import { describe, expect, test } from 'bun:test'
import {
  fuzzyIndices,
  highlightSegments,
  splitFilePath,
} from '../../src/renderer/components/search/lib/file-picker'

// The picker's ranking comes from the native index; these highlights only
// explain it. A highlight that lands on the wrong characters makes a correct
// ranking look broken, so the alignment is what matters here.

function rendered(text: string, query: string): string {
  return highlightSegments(text, fuzzyIndices(text, query))
    .map((segment) => (segment.isMatch ? `[${segment.text}]` : segment.text))
    .join('')
}

describe('fuzzy path highlighting', () => {
  test('marks a contiguous run', () => {
    expect(rendered('session.ts', 'sess')).toBe('[sess]ion.ts')
  })

  test('marks a scattered subsequence', () => {
    expect(rendered('taskService.ts', 'tsv')).toBe('[t]ask[S]er[v]ice.ts')
  })

  test('prefers the last occurrence so the file name wins over its folder', () => {
    // Left-to-right matching would highlight `tests/` and leave the file name
    // — the part the user is actually reading — unmarked.
    expect(rendered('tests/unit/test.ts', 'test')).toBe('tests/unit/[test].ts')
  })

  test('is case-insensitive but preserves the original text', () => {
    expect(rendered('TaskService.ts', 'task')).toBe('[Task]Service.ts')
  })

  test('returns null when the query is not a subsequence', () => {
    expect(fuzzyIndices('session.ts', 'zzz')).toBeNull()
    expect(rendered('session.ts', 'zzz')).toBe('session.ts')
  })

  test('an empty query highlights nothing', () => {
    expect(fuzzyIndices('session.ts', '   ')).toBeNull()
    expect(highlightSegments('session.ts', null)).toEqual([
      { text: 'session.ts', isMatch: false },
    ])
  })

  test('segments always reproduce the original text', () => {
    const text = 'src/renderer/components/search/FilePickerOverlay.svelte'
    for (const query of ['file', 'srcsvelte', 'overlay', 'x']) {
      const joined = highlightSegments(text, fuzzyIndices(text, query))
        .map((segment) => segment.text)
        .join('')
      expect(joined).toBe(text)
    }
  })
})

describe('path splitting', () => {
  test('keeps the trailing separator on the directory half', () => {
    expect(splitFilePath('src/lib/a.ts')).toEqual({ name: 'a.ts', directory: 'src/lib/' })
  })

  test('a bare file name has no directory', () => {
    expect(splitFilePath('README.md')).toEqual({ name: 'README.md', directory: '' })
  })
})
