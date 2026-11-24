import { JSDOM } from 'jsdom'
import { tableClipboardPayload } from '../../packages/workspace-ui/src/components/conversation/lib/table-clipboard'
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

test('HTML keeps formatting, headers and cell boundaries while omitting interactive content', () => {
  const dom = new JSDOM(`<table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody>
    <tr><td><strong>A &amp; B</strong><svg aria-hidden="true"></svg></td>
    <td><a href="javascript:void(0)" onclick="alert(1)"><code>ready</code></a></td></tr>
  </tbody></table>`)
  const table = dom.window.document.querySelector('table')!
  const { html, text } = tableClipboardPayload(table)
  expect(html).toContain('<thead>')
  expect(html).toContain('<strong>A &amp; B</strong>')
  expect(html).toContain('<code>ready</code>')
  expect(html).not.toMatch(/svg|javascript:|onclick/)
  expect(text).toBe('Name\tStatus\nA & B\tready')
})
