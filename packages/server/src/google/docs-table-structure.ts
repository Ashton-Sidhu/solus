import type { DocsRequest, DocsTableCellLocation } from './docs-api'
import type { TableBlock } from './docs-requests'
import { type EditableDocument, type EditableTable, UNSUPPORTED_GOOGLE_EDIT } from './docs-edit-schema'
import { paragraphText, type TextEdit } from './docs-edit-plan'
import { emptyParagraph, reindexDocument, sequenceChange, type SequenceChange } from './docs-structure-model'

interface StructuralChanges { requests: DocsRequest[]; edits: TextEdit[] }

function tableValues(table: EditableTable): string[][] {
  if (table.table.tableRows.length !== table.table.rows) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  return table.table.tableRows.map(row => {
    if (row.tableCells.length !== table.table.columns) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    return row.tableCells.map(cell => {
      if (cell.content.length !== 1) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
      return paragraphText(cell.content[0])
    })
  })
}

function rowsChange(document: EditableDocument, table: EditableTable, change: SequenceChange, result: StructuralChanges): void {
  const rows = table.table.tableRows
  for (let step = 0; step < change.count; step++) {
    const index = change.index + (change.insert ? step : 0)
    const location: DocsTableCellLocation = {
      tableStartLocation: { index: table.startIndex, tabId: document.tabs[0].tabProperties.tabId },
      rowIndex: Math.min(index, rows.length - 1), columnIndex: 0,
    }
    if (change.insert) {
      const start = index === rows.length ? rows.at(-1)!.endIndex! : rows[index].startIndex!
      result.requests.push({ insertTableRow: { tableCellLocation: location, insertBelow: index === rows.length } })
      result.edits.push({ start, end: start, text: '\0' + '\0\n'.repeat(table.table.columns) })
      rows.splice(index, 0, { tableCells: Array.from({ length: table.table.columns }, () => ({ startIndex: 0, endIndex: 0, content: [emptyParagraph()] })) })
    } else {
      const row = rows[index]
      result.requests.push({ deleteTableRow: { tableCellLocation: location } })
      result.edits.push({ start: row.startIndex!, end: row.endIndex!, text: '' })
      rows.splice(index, 1)
    }
    table.table.rows = rows.length
    reindexDocument(document)
  }
}

function columnsChange(document: EditableDocument, table: EditableTable, change: SequenceChange, result: StructuralChanges): void {
  for (let step = 0; step < change.count; step++) {
    const index = change.index + (change.insert ? step : 0)
    const location: DocsTableCellLocation = {
      tableStartLocation: { index: table.startIndex, tabId: document.tabs[0].tabProperties.tabId },
      rowIndex: 0, columnIndex: Math.min(index, table.table.columns - 1),
    }
    if (change.insert) result.requests.push({ insertTableColumn: { tableCellLocation: location, insertRight: index === table.table.columns } })
    else result.requests.push({ deleteTableColumn: { tableCellLocation: location } })
    for (const row of [...table.table.tableRows].reverse()) {
      const cells = row.tableCells
      if (change.insert) {
        const start = index === cells.length ? cells.at(-1)!.endIndex : cells[index].startIndex
        result.edits.push({ start, end: start, text: '\0\n' })
        cells.splice(index, 0, { startIndex: 0, endIndex: 0, content: [emptyParagraph()] })
      } else {
        const cell = cells[index]
        result.edits.push({ start: cell.startIndex, end: cell.endIndex, text: '' })
        cells.splice(index, 1)
      }
    }
    table.table.columns += change.insert ? 1 : -1
    reindexDocument(document)
  }
}

/** Only one dimension changes at a time. Existing values establish identity;
 * newly inserted empty cells are filled by the normal paragraph planner. */
export function changeTableStructure(document: EditableDocument, table: EditableTable, target: TableBlock): StructuralChanges {
  const result: StructuralChanges = { requests: [], edits: [] }
  const before = tableValues(table), after = target.rows.map(row => row.map(cell => cell.text))
  const columns = after[0]?.length
  if (!columns || after.some(row => row.length !== columns)) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  if (before.length === after.length && table.table.columns === columns) return result
  if (before.length !== after.length && table.table.columns !== columns) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  if (table.table.columns === columns) {
    rowsChange(document, table, sequenceChange(before.map(row => JSON.stringify(row)), after.map(row => JSON.stringify(row))), result)
  } else {
    const transpose = (rows: string[][]) => rows[0].map((_, column) => JSON.stringify(rows.map(row => row[column])))
    columnsChange(document, table, sequenceChange(transpose(before), transpose(after)), result)
  }
  return result
}
