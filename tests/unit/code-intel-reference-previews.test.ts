import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CodeIntelLocation } from '@solus/contracts/code-intel'
import {
  MAX_PREVIEW_LENGTH,
  previewFromLine,
  withReferencePreviews,
} from '@solus/server/code-intel/reference-previews'

/**
 * A reference list is only worth reading if each row is the line of code it
 * points at. These tests pin the two things that make that true: the excerpt
 * always contains the symbol, and the offsets still point at it.
 */

const at = (path: string, line: number, startCharacter: number, endCharacter: number): CodeIntelLocation => ({
  path,
  range: { startLine: line, startCharacter, endLine: line, endCharacter },
})

describe('previewFromLine', () => {
  test('drops indentation and moves the match offsets with it', () => {
    const preview = previewFromLine('      parts = formatLocation(loc)', 14, 28)
    expect(preview.text).toBe('parts = formatLocation(loc)')
    expect(preview.text.slice(preview.matchStart, preview.matchEnd)).toBe('formatLocation')
  })

  test('a minified line is windowed around the symbol rather than truncated past it', () => {
    const filler = 'x'.repeat(400)
    const preview = previewFromLine(`${filler}formatLocation${filler}`, 400, 414)
    expect(preview.text.length).toBeLessThanOrEqual(MAX_PREVIEW_LENGTH + 2)
    expect(preview.text.slice(preview.matchStart, preview.matchEnd)).toBe('formatLocation')
  })
})

describe('withReferencePreviews', () => {
  test('reads each file once and returns every reference, previewed or not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'solus-code-intel-previews-'))
    await writeFile(join(root, 'a.ts'), ['const a = 1', '  useSymbol(a)', 'const b = 2'].join('\n'))

    const previewed = await withReferencePreviews(root, [
      at('a.ts', 1, 2, 11),
      at('a.ts', 99, 0, 1),
      at('gone.ts', 0, 0, 1),
    ])

    expect(previewed).toHaveLength(3)
    expect(previewed[0]!.preview?.text).toBe('useSymbol(a)')
    expect(previewed[0]!.preview!.matchEnd - previewed[0]!.preview!.matchStart).toBe(9)
    // A line past the end of the file and a file that is gone both lose only
    // the preview; the row still has a line number to navigate to.
    expect(previewed[1]!.preview).toBeNull()
    expect(previewed[2]!.preview).toBeNull()
  })
})
