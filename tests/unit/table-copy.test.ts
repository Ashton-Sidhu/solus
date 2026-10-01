import { describe, expect, test } from 'bun:test'
import { rowsToCsv, rowsToMarkdown } from '../../packages/workspace-ui/src/components/conversation/lib/table-copy'

describe('copying a reply table', () => {
  const rows = [
    ['Name', 'Note'],
    ['a|b', 'says "hi", twice'],
    ['short'],
  ]

  test('markdown keeps the table a table: escaped pipes and a full-width header rule', () => {
    // WHY: an unescaped `|` adds a column, and a short row would shift its cells
    // under the wrong header when pasted.
    expect(rowsToMarkdown(rows)).toBe(
      ['| Name | Note |', '| --- | --- |', '| a\\|b | says "hi", twice |', '| short |  |'].join('\n'),
    )
  })

  test('csv quotes only the fields that need it', () => {
    // WHY: a comma or a quote in a cell must not split it into two columns in a spreadsheet.
    expect(rowsToCsv(rows)).toBe(['Name,Note', 'a|b,"says ""hi"", twice"', 'short'].join('\n'))
  })
})
