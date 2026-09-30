import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'

type CellAlign = 'left' | 'center' | 'right'

interface RenderedCell {
  text: string
  isHeader: boolean
  align: CellAlign | null
}

function cellAlign(attrs: JSONContent['attrs']): CellAlign | null {
  const align = attrs?.align
  return align === 'left' || align === 'center' || align === 'right' ? align : null
}

/** One cell's markdown on one line. A cell with several paragraphs, or a hard
 *  break, keeps its line breaks as `<br>`: GFM has no other way to say it. */
function renderCell(cell: JSONContent, h: MarkdownRendererHelpers): RenderedCell {
  const content = cell.content ?? []
  const raw = content.length > 1
    ? content.map((child) => h.renderChildren(child)).join('\n')
    : h.renderChildren(content)
  const text = raw.replace(/[ \t]*\r?\n[ \t]*/g, '<br>').replace(/\s+/g, ' ').trim()
  return { text, isHeader: cell.type === 'tableHeader', align: cellAlign(cell.attrs) }
}

/** A delimiter cell exactly as wide as its column, colons included. */
function delimiter(width: number, align: CellAlign | null): string {
  if (align === 'left') return `:${'-'.repeat(width - 1)}`
  if (align === 'right') return `${'-'.repeat(width - 1)}:`
  if (align === 'center') return `:${'-'.repeat(width - 2)}:`
  return '-'.repeat(width)
}

/**
 * A GFM table whose columns line up, and nothing around it.
 *
 * Tiptap's serializer writes the alignment row two characters wider than the
 * column whenever a column is aligned, and it wraps the table in extra blank
 * lines, so every open-and-save of a work rewrote each of its tables. The
 * alignment is a column property: the first alignment found in a column is
 * written for the whole column.
 */
export function renderDocumentTable(node: JSONContent, h: MarkdownRendererHelpers): string {
  const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => renderCell(cell, h)))
  const columnCount = Math.max(0, ...rows.map((row) => row.length))
  if (columnCount === 0) return ''

  const columns = Array.from({ length: columnCount }, (_, index) => index)
  const widths = columns.map((index) => Math.max(3, ...rows.map((row) => row[index]?.text.length ?? 0)))
  const aligns = columns.map((index) => rows.find((row) => row[index]?.align)?.[index]?.align ?? null)
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const textRow = (row: RenderedCell[]) => line(columns.map((index) => (row[index]?.text ?? '').padEnd(widths[index])))

  const hasHeader = rows[0].some((cell) => cell.isHeader)
  const header = hasHeader ? rows[0] : []
  const body = hasHeader ? rows.slice(1) : rows
  return [
    textRow(header),
    line(columns.map((index) => delimiter(widths[index], aligns[index]))),
    ...body.map(textRow),
  ].join('\n')
}

/** Tables with Tiptap's schema and parser, and a stable serializer. */
export const DocumentTable = Table.extend({
  renderMarkdown: renderDocumentTable,
})
