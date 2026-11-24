const clipboardElements = new Set(['STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'CODE', 'BR', 'A'])

function copyCellContent(source: Node, destination: Node, document: Document): void {
  if (source.nodeType === 3) {
    destination.appendChild(document.createTextNode(source.textContent ?? ''))
    return
  }
  if (!(source instanceof document.defaultView!.Element) || source.matches('svg, [aria-hidden="true"], .solus-token__copy-only')) return
  let target = destination
  if (clipboardElements.has(source.tagName)) {
    const element = document.createElement(source.localName)
    if (element instanceof document.defaultView!.HTMLAnchorElement && source instanceof document.defaultView!.HTMLAnchorElement &&
        /^(https?:|mailto:)/i.test(source.href)) element.href = source.href
    destination.appendChild(element)
    target = element
  }
  for (const child of source.childNodes) copyCellContent(child, target, document)
}

export function tableClipboardPayload(table: HTMLTableElement) {
  const document = table.ownerDocument
  const copy = document.createElement('table')
  copy.style.borderCollapse = 'collapse'
  const lines: string[] = []
  for (const section of Array.from(table.children)) {
    if (!(section instanceof document.defaultView!.HTMLTableSectionElement)) continue
    const copySection = document.createElement(section.localName)
    copy.append(copySection)
    for (const row of Array.from(section.rows)) {
      const copyRow = document.createElement('tr')
      copySection.append(copyRow)
      const cells: string[] = []
      for (const cell of Array.from(row.cells)) {
        const copyCell = document.createElement(cell.localName)
        copyCell.style.cssText = 'border:1px solid #aaa;padding:4px 8px'
        if (cell.style.textAlign) copyCell.style.textAlign = cell.style.textAlign
        copyCellContent(cell, copyCell, document)
        copyRow.append(copyCell)
        cells.push((copyCell.textContent ?? '').replace(/[\t\r\n]+/g, ' ').trim())
      }
      lines.push(cells.join('\t'))
    }
  }
  return { html: copy.outerHTML, text: lines.join('\n') }
}

export async function copyMarkdownTable(table: HTMLTableElement): Promise<void> {
  const { html, text } = tableClipboardPayload(table)
  if (navigator.clipboard?.write && globalThis.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })])
      return
    } catch {
      // Some browsers accept clipboard text but reject rich clipboard items.
    }
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = table.ownerDocument.createElement('textarea')
  textarea.value = text
  textarea.style.cssText = 'position:fixed;opacity:0'
  table.ownerDocument.body.append(textarea)
  try {
    textarea.select()
    if (!table.ownerDocument.execCommand('copy')) throw new Error('Clipboard unavailable')
  } finally {
    textarea.remove()
  }
}
