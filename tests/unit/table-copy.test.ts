import { JSDOM } from 'jsdom'
import { canCopyTablePng, copyTablePng, copyTableText, tableClipboardPayload } from '../../packages/workspace-ui/src/components/conversation/lib/table-clipboard'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { rowsToCsv, rowsToMarkdown } from '../../packages/workspace-ui/src/components/conversation/lib/table-copy'
import { renderTablePng } from '../../packages/workspace-ui/src/components/conversation/lib/table-png'

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

const restoreProperties: Array<() => void> = []

function replaceProperty(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, value })
  restoreProperties.push(() => {
    if (original) Object.defineProperty(target, key, original)
    else Reflect.deleteProperty(target, key)
  })
}

afterEach(() => {
  for (const restore of restoreProperties.splice(0).reverse()) restore()
})

class TestClipboardItem {
  static supports = (_type: string) => true
  constructor(readonly data: { 'image/png': Promise<Blob> }) {}
}

test('PNG copy starts the clipboard write while the selection event is still active', async () => {
  const png = new Blob(['test'], { type: 'image/png' })
  const render = mock(async () => png)
  const write = mock(async ([item]: TestClipboardItem[]) => {
    expect(render).not.toHaveBeenCalled()
    expect(Object.keys(item.data)).toEqual(['image/png'])
    expect(await item.data['image/png']).toBe(png)
  })
  replaceProperty(navigator, 'clipboard', { write })
  replaceProperty(globalThis, 'ClipboardItem', TestClipboardItem)
  expect(canCopyTablePng()).toBe(true)
  const copying = copyTablePng(render)
  expect(write).toHaveBeenCalledTimes(1)
  await copying
})

test('missing clipboard access or PNG support skips rendering', async () => {
  const render = mock(async () => new Blob())
  replaceProperty(navigator, 'clipboard', undefined)
  expect(canCopyTablePng()).toBe(false)
  await expect(copyTablePng(render)).rejects.toThrow('Image clipboard unavailable')

  const write = mock(async () => {})
  replaceProperty(navigator, 'clipboard', { write })
  replaceProperty(globalThis, 'ClipboardItem', TestClipboardItem)
  replaceProperty(TestClipboardItem, 'supports', () => false)
  expect(canCopyTablePng()).toBe(false)
  await expect(copyTablePng(render)).rejects.toThrow('Image clipboard unavailable')
  expect(render).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

test('clipboard and render errors reach the table action', async () => {
  replaceProperty(globalThis, 'ClipboardItem', TestClipboardItem)
  replaceProperty(navigator, 'clipboard', {
    write: async () => { throw new Error('Clipboard denied') },
    writeText: async () => { throw new Error('Clipboard denied') },
  })
  const { document } = new JSDOM().window
  await expect(copyTableText('a,b', document)).rejects.toThrow('Clipboard denied')
  await expect(copyTablePng(async () => new Blob())).rejects.toThrow('Clipboard denied')

  replaceProperty(navigator, 'clipboard', {
    write: async ([item]: TestClipboardItem[]) => { await item.data['image/png'] },
  })
  await expect(copyTablePng(async () => { throw new Error('Encode failed') })).rejects.toThrow('Encode failed')
})

test('PNG covers the far column when the scroll wrapper is narrower and scrolled', async () => {
  const { window } = new JSDOM(`
    <style>* { opacity: 1; clip-path: none; overflow-x: visible; overflow-y: visible; }</style>
    <div style="overflow-x: auto"><table><tbody><tr><td></td><td style="background: red"></td></tr></tbody></table></div>
  `)
  const { document } = window
  const table = document.querySelector('table')!
  const wrapper = table.parentElement!
  wrapper.scrollLeft = 60
  wrapper.getBoundingClientRect = () => new window.DOMRect(0, 0, 100, 30)
  table.getBoundingClientRect = () => new window.DOMRect(-60, 0, 300, 30)
  const lastCell = table.rows[0].cells[1]
  replaceProperty(lastCell, 'getClientRects', () => [new window.DOMRect(160, 0, 80, 30)])
  const fillRect = mock((_x: number, _y: number, _width: number, _height: number) => {})
  const png = new Blob(['test'], { type: 'image/png' })
  replaceProperty(globalThis, 'OffscreenCanvas', class {
    getContext() { return { fillRect, scale() {} } }
    async convertToBlob() { return png }
  })

  expect(await renderTablePng(table)).toBe(png)
  expect(fillRect).toHaveBeenCalledWith(0, 0, 332, 62)
  expect(fillRect).toHaveBeenCalledWith(236, 16, 80, 30)

  table.remove()
  await expect(renderTablePng(table)).rejects.toThrow('left the page')
})
