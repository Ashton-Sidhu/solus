import { UNSUPPORTED_GOOGLE_EDIT, type EditableDocument, type EditableParagraph } from './docs-edit-schema'

/** Index layout is defined by the Docs API. Validate the original layout before
 * using it to predict positions after structural operations in the same batch. */
export function reindexDocument(document: EditableDocument): void {
  let cursor = 1
  const paragraph = (element: EditableParagraph) => {
    element.startIndex = cursor
    for (const run of element.paragraph.elements) {
      run.startIndex = cursor
      cursor += 'textRun' in run ? run.textRun.content.length : 1
      run.endIndex = cursor
    }
    element.endIndex = cursor
  }
  for (const element of document.tabs[0].documentTab.body.content) {
    if ('sectionBreak' in element) {
      if (element.endIndex !== 1) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
      continue
    }
    element.startIndex = cursor
    if ('paragraph' in element) paragraph(element)
    else {
      cursor++
      for (const row of element.table.tableRows) {
        row.startIndex = cursor++
        for (const cell of row.tableCells) {
          cell.startIndex = cursor++
          for (const part of cell.content) paragraph(part)
          cell.endIndex = cursor
        }
        row.endIndex = cursor
      }
      cursor++
    }
    element.endIndex = cursor
  }
}

export function emptyParagraph(startIndex = 0): EditableParagraph {
  return { startIndex, endIndex: startIndex + 1, paragraph: { elements: [{ startIndex, endIndex: startIndex + 1, textRun: { content: '\n' } }] } }
}

export interface SequenceChange { index: number; count: number; insert: boolean }

/** A contiguous insertion/deletion must have one possible alignment. Repeated
 * rows or paragraphs must not make us choose an arbitrary original to delete. */
export function sequenceChange(before: string[], after: string[]): SequenceChange {
  const insert = after.length > before.length
  const count = Math.abs(after.length - before.length)
  if (!count || count > 100 || Math.max(before.length, after.length) > 2000 || !before.length || !after.length) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  const short = insert ? before : after, long = insert ? after : before
  const candidates: number[] = []
  for (let index = 0; index <= short.length; index++) {
    if (short.every((value, position) => value === long[position < index ? position : position + count])) candidates.push(index)
  }
  if (candidates.length !== 1) throw new Error('The structural change cannot be matched safely. Keep existing rows, columns, or paragraphs unchanged when adding or removing others.')
  return { index: candidates[0], count, insert }
}
