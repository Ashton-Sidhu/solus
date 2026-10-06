import { describe, expect, test } from 'bun:test'
import type { NativeMarkdownTextRun } from '../../apps/mobile/modules/t3-markdown-text/src/nativeMarkdownText'
import {
  deriveMarkdownTableColumnWidths,
  MARKDOWN_TABLE_CELL_PADDING_X,
  measureMarkdownTableCell,
} from '../../apps/mobile/modules/t3-markdown-text/src/markdownTableLayout'

const FONT = 15
const cell = (...runs: NativeMarkdownTextRun[]) => measureMarkdownTableCell(runs, FONT)
const code = (text: string): NativeMarkdownTextRun => ({ text, code: true })
const prose = (text: string): NativeMarkdownTextRun => ({ text })
const sum = (widths: number[]) => widths.reduce((total, width) => total + width, 0)

// The table from the reported tablet screenshot: method names beside short prose.
const methods = [
  [cell(prose('Method')), cell(prose('Purpose')), cell(prose('Status'))],
  [cell(code('sessionPullRequestsList')), cell(prose('Lists the pull requests a session opened')), cell(prose('Done'))],
  [cell(code('listProjectIdentities')), cell(prose('Names each project once')), cell(prose('Open'))],
  [cell(code('serverGetCapabilities')), cell(prose('Reports what the host supports')), cell(prose('Done'))],
]

describe('native markdown table columns', () => {
  test('a tablet table fills the pane instead of three fixed 160pt columns', () => {
    const widths = deriveMarkdownTableColumnWidths(methods, 900)
    expect(sum(widths)).toBeGreaterThan(890)
    expect(sum(widths)).toBeLessThanOrEqual(900)
    // Columns follow their text: the purpose column is the widest, the status column the narrowest.
    expect(widths[1]).toBeGreaterThan(widths[0]!)
    expect(widths[2]).toBeLessThan(widths[0]!)
  })

  test('a code identifier never breaks mid-word while its column can hold it', () => {
    const identifier = cell(code('sessionPullRequestsList'))
    for (const pane of [320, 600, 900]) {
      const widths = deriveMarkdownTableColumnWidths(methods, pane)
      expect(widths[0]! - MARKDOWN_TABLE_CELL_PADDING_X * 2).toBeGreaterThanOrEqual(Math.floor(identifier.longestWord))
    }
  })

  test('a phone pane narrower than the longest words scrolls the table, not the feed', () => {
    const widths = deriveMarkdownTableColumnWidths(methods, 320)
    expect(sum(widths)).toBeGreaterThan(320)
    // Prose cells wrap at spaces: the purpose column shrinks to its longest word, not its full sentence.
    expect(widths[1]).toBeLessThan(cell(prose('Lists the pull requests a session opened')).singleLine)
  })

  test('a mid-size pane wraps prose columns and still fits without scrolling', () => {
    const widths = deriveMarkdownTableColumnWidths(methods, 560)
    expect(sum(widths)).toBeLessThanOrEqual(560)
  })

  test('a word spans runs, so `foo`**bar** is measured as one word', () => {
    expect(cell(code('foo'), prose('bar')).longestWord).toBeCloseTo(cell(code('foo')).longestWord + cell(prose('bar')).longestWord)
    expect(cell(prose('foo bar')).longestWord).toBeCloseTo(cell(prose('foo')).longestWord)
  })

  test('rows with missing cells still size every column', () => {
    expect(deriveMarkdownTableColumnWidths([[cell(prose('a')), cell(prose('b'))], [cell(prose('c'))]], 400)).toHaveLength(2)
  })
})
