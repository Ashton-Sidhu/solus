// What the pointer is doing over a table.
//
// Rows in Insights are clickable, which is exactly what stops a reader
// selecting the text inside one: the mouse-up that ends a drag-select is also
// a click, so the row opens and the selection is gone. `hasTextSelection`
// makes activation defer to a selection the reader is holding.
//
// The context menu reads its subject from the rendered row rather than from
// the table model, because what a reader wants copied is what they can see —
// `26m54`, `$0.646`, `Aug 17 23:22` — not the epoch and the float behind them.
// That also makes one menu serve all three grains.

export interface CellContext {
  columnId: string | null
  columnLabel: string | null
  /** The cell under the pointer, as rendered. */
  cellText: string
  /** The whole row, tab separated, so it pastes into a spreadsheet as a row. */
  rowText: string
}

export function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return selection != null && !selection.isCollapsed && selection.toString().trim().length > 0
}

function readableText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export function cellContextFrom(event: MouseEvent): CellContext {
  const target = event.target instanceof Element ? event.target : null
  const cell = target?.closest('td') ?? null
  const row = cell?.closest('tr') ?? null
  const cells = row ? Array.from(row.querySelectorAll('td')) : []
  return {
    columnId: cell?.dataset.columnId ?? null,
    columnLabel: cell?.dataset.columnLabel ?? null,
    cellText: cell ? readableText(cell) : '',
    rowText: cells.map(readableText).join('\t'),
  }
}
