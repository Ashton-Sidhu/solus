import type { RowData, SvelteTable } from '@tanstack/svelte-table'
import type { InsightsTableFeatures } from './data-table-features'

// Column widths an Insights table did not choose.
//
// A default width is a guess about content nobody has seen yet: a uuid, a
// shell command, and a model name all arrive in the same column shape. So the
// reader is allowed to overrule it, and the three ways to do that — drag,
// arrow keys, double-click — all end up here.
//
// A width the reader set is theirs until they hand it back, which is what
// `isColumnResized` answers: a column that grew into the row's leftover width
// stops doing that the moment someone drags it.

type InsightsTable<TData extends RowData> = SvelteTable<InsightsTableFeatures, TData>

const FALLBACK_MIN_PX = 48

export function nudgeColumnSize<TData extends RowData>(
  table: InsightsTable<TData>,
  columnId: string,
  deltaPx: number,
): void {
  const column = table.getColumn(columnId)
  if (!column) return
  const minimum = column.columnDef.minSize ?? FALLBACK_MIN_PX
  const next = Math.max(minimum, column.getSize() + deltaPx)
  table.setColumnSizing((sizing) => ({ ...sizing, [columnId]: next }))
}

/**
 * Begin a drag from the width the column actually has on screen.
 *
 * The column that absorbs the row's leftover width renders wider than the size
 * the table holds for it — 900px on screen, 360 in state. A drag starts from
 * the stored number, so without this the column snapped back to its default on
 * the first pointer move and only then followed the pointer. Seeding also
 * settles the column at its current width, which is the same thing the reader
 * asked for by grabbing its edge.
 */
export function seedColumnSize<TData extends RowData>(
  table: InsightsTable<TData>,
  columnId: string,
  renderedWidthPx: number,
): void {
  if (!(renderedWidthPx > 0) || isColumnResized(table, columnId)) return
  const column = table.getColumn(columnId)
  if (!column) return
  const minimum = column.columnDef.minSize ?? FALLBACK_MIN_PX
  const seeded = Math.max(minimum, Math.round(renderedWidthPx))
  table.setColumnSizing((sizing) => ({ ...sizing, [columnId]: seeded }))
}

/** Hand the column back to its default width. */
export function resetColumnSize<TData extends RowData>(
  table: InsightsTable<TData>,
  columnId: string,
): void {
  table.setColumnSizing((sizing) => {
    const next = { ...sizing }
    delete next[columnId]
    return next
  })
}

export function isColumnResized<TData extends RowData>(
  table: InsightsTable<TData>,
  columnId: string,
): boolean {
  return table.atoms.columnSizing.get()[columnId] !== undefined
}
