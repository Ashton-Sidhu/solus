import type { DiffMoveAnalysis } from './diff-moves'

interface RenderedDiffHost {
  id: string
  element: HTMLElement
}

function resolveLine(
  shadow: ShadowRoot,
  side: 'old' | 'new',
  lineNumber: number,
  diffStyle: 'unified' | 'split',
): HTMLElement | null {
  const sideColumn = side === 'old' ? '[data-deletions]' : '[data-additions]'
  if (diffStyle === 'split') {
    const column = shadow.querySelector(sideColumn) ?? shadow.querySelector('[data-unified]')
    return column?.querySelector(`[data-content] [data-line="${lineNumber}"]`) as HTMLElement | null
  }

  const column = shadow.querySelector('[data-unified]') ?? shadow.querySelector(sideColumn)
  const candidates = Array.from(
    column?.querySelectorAll(`[data-content] [data-line="${lineNumber}"]`) ?? [],
  )
  for (const candidate of candidates) {
    const deletion = candidate.getAttribute('data-line-type') === 'change-deletion'
    if (side === 'old' ? deletion : !deletion) return candidate as HTMLElement
  }
  return (candidates[0] as HTMLElement | undefined) ?? null
}

function clearDecorations(shadow: ShadowRoot): void {
  for (const wrapper of Array.from(shadow.querySelectorAll('[data-solus-move-edit]'))) {
    wrapper.replaceWith(...Array.from(wrapper.childNodes))
  }
  for (const line of Array.from(shadow.querySelectorAll('[data-solus-moved]'))) {
    line.removeAttribute('data-solus-moved')
  }
}

function wrapRange(line: HTMLElement, side: 'old' | 'new', start: number, length: number): void {
  if (length <= 0) return
  const end = start + length
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  const nodes: Array<{ node: Text; start: number; end: number }> = []
  let offset = 0
  let node = walker.nextNode() as Text | null
  while (node) {
    nodes.push({ node, start: offset, end: offset + node.data.length })
    offset += node.data.length
    node = walker.nextNode() as Text | null
  }

  for (let index = nodes.length - 1; index >= 0; index--) {
    const item = nodes[index]
    const overlapStart = Math.max(start, item.start)
    const overlapEnd = Math.min(end, item.end)
    if (overlapStart >= overlapEnd) continue
    let selected = item.node
    const localEnd = overlapEnd - item.start
    const localStart = overlapStart - item.start
    if (localEnd < selected.length) selected.splitText(localEnd)
    if (localStart > 0) selected = selected.splitText(localStart)
    const wrapper = document.createElement('span')
    wrapper.dataset.solusMoveEdit = side
    selected.replaceWith(wrapper)
    wrapper.appendChild(selected)
  }
}

/** Applies paint-only move metadata after Pierre has rendered/recycled a host. */
export function decorateMovedLines(
  renderedItems: RenderedDiffHost[],
  analysis: DiffMoveAnalysis,
  diffStyle: 'unified' | 'split',
): void {
  for (const item of renderedItems) {
    const shadow = item.element.shadowRoot
    if (!shadow) continue
    clearDecorations(shadow)
    const summary = analysis.byFile.get(item.id)
    if (!summary) continue
    for (const moved of summary.lines) {
      const line = resolveLine(shadow, moved.side, moved.lineNumber, diffStyle)
      if (!line) continue
      line.dataset.solusMoved = ''
      for (const range of moved.editRanges) wrapRange(line, moved.side, range.start, range.length)
    }
  }
}
