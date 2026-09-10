import { compileDocsBlocks, type DocsBlock } from './docs-requests'
import type { DocsRequest } from './docs-api'
import { type EditableDocument, type EditableParagraph, type EditableTable, UNSUPPORTED_GOOGLE_EDIT } from './docs-edit-schema'
import { documentIndexedText, paragraphText, protectComments, type TextEdit } from './docs-edit-plan'
import { emptyParagraph, reindexDocument, sequenceChange } from './docs-structure-model'
import { changeTableStructure } from './docs-table-structure'

export interface GoogleStructurePlan { document: EditableDocument; requests: DocsRequest[]; edits: TextEdit[] }
type VisibleElement = EditableParagraph | EditableTable
function visibleElements(document: EditableDocument): VisibleElement[] {
  return document.tabs[0].documentTab.body.content.filter((element): element is VisibleElement => {
    if ('table' in element) return true
    return 'paragraph' in element && !element.paragraph.elements.some(run => 'inlineObjectElement' in run) && !!paragraphText(element).trim()
  })
}
function keys(elements: VisibleElement[] | DocsBlock[]): string[] {
  let table = 0
  return elements.map(element => {
    if ('table' in element || ('kind' in element && element.kind === 'table')) return 'table:' + table++
    if ('paragraph' in element) return 'paragraph:' + paragraphText(element)
    if ('kind' in element && element.kind === 'paragraph') return 'paragraph:' + element.text.text
    throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  })
}
function textParagraph(text: string): EditableParagraph {
  const paragraph = emptyParagraph()
  paragraph.paragraph.elements = [{ startIndex: 0, endIndex: text.length + 1, textRun: { content: text + '\n' } }]
  return paragraph
}

function insertParagraphs(plan: GoogleStructurePlan, elements: VisibleElement[], blocks: DocsBlock[], index: number, count: number): void {
  const content = plan.document.tabs[0].documentTab.body.content
  const next = elements[index]
  let bodyIndex = next ? content.indexOf(next) : content.length - 1
  if (next && 'table' in next) {
    const previous = content[bodyIndex - 1]
    if (!previous || !('paragraph' in previous) || paragraphText(previous) !== '') throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    bodyIndex--
  }
  const boundary = content[bodyIndex]
  if (!boundary || !('paragraph' in boundary)) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  const added = blocks.slice(index, index + count)
  const paragraphs = added.map(block => {
    if (block.kind !== 'paragraph' || block.bullet || block.baseText || block.text.text.includes('\n')) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    return block
  })
  // If there is no spare final paragraph, insert before its final newline and
  // supply a leading newline to preserve the existing last paragraph.
  const appendToLast = !next && paragraphText(boundary) !== ''
  const start = appendToLast ? boundary.endIndex - 1 : boundary.startIndex
  const text = (appendToLast ? '\n' : '') + paragraphs.map(block => block.text.text).join('\n') + (appendToLast ? '' : '\n')
  const tabId = plan.document.tabs[0].tabProperties.tabId
  plan.requests.push({ insertText: { location: { index: start, tabId }, text } })
  plan.edits.push({ start, end: start, text })
  content.splice(bodyIndex + (appendToLast ? 1 : 0), 0, ...paragraphs.map(block => textParagraph(block.text.text)))
  reindexDocument(plan.document)
  let cursor = start + (appendToLast ? 1 : 0)
  for (const block of paragraphs) {
    const range = { startIndex: cursor, endIndex: cursor + block.text.text.length + 1, tabId }
    plan.requests.push({ updateTextStyle: { range, textStyle: { bold: false, italic: false, strikethrough: false }, fields: 'bold,italic,strikethrough,link' } })
    plan.requests.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: block.style.namedStyleType ?? 'NORMAL_TEXT' }, fields: 'namedStyleType' } })
    cursor = range.endIndex
  }
}

function changeParagraphStructure(plan: GoogleStructurePlan, blocks: DocsBlock[]): void {
  const elements = visibleElements(plan.document)
  if (elements.length === blocks.length) return
  const change = sequenceChange(keys(elements), keys(blocks))
  if (change.insert) { insertParagraphs(plan, elements, blocks, change.index, change.count); return }
  const content = plan.document.tabs[0].documentTab.body.content
  const tabId = plan.document.tabs[0].tabProperties.tabId
  for (const element of elements.slice(change.index, change.index + change.count).reverse()) {
    if (!('paragraph' in element)) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    const bodyIndex = content.indexOf(element)
    const last = bodyIndex === content.length - 1
    const end = element.endIndex - (last ? 1 : 0)
    plan.edits.push({ start: element.startIndex, end, text: '' })
    plan.requests.push({ deleteContentRange: { range: { startIndex: element.startIndex, endIndex: end, tabId } } })
    if (last) content[bodyIndex] = emptyParagraph(element.startIndex)
    else content.splice(bodyIndex, 1)
    reindexDocument(plan.document)
  }
}

/** Predict structural changes without sending them. Text/style planning runs on
 * the resulting document, and the adapter sends both parts in one atomic batch. */
export function planGoogleDocStructure(document: EditableDocument, markdown: string, quotes: string[]): GoogleStructurePlan {
  const blocks = compileDocsBlocks(markdown, []).filter(block => block.kind !== 'paragraph' || block.text.text.trim())
  const elements = visibleElements(document)
  const needsStructure = elements.length !== blocks.length || elements.some((element, index) => {
    const block = blocks[index]
    return 'table' in element && block?.kind === 'table' && (element.table.rows !== block.rows.length || element.table.columns !== block.rows[0]?.length)
  })
  if (!needsStructure) return { document, requests: [], edits: [] }
  const plan: GoogleStructurePlan = { document: structuredClone(document), requests: [], edits: [] }
  const original = documentIndexedText(document)
  reindexDocument(plan.document)
  if (documentIndexedText(plan.document) !== original) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  changeParagraphStructure(plan, blocks)
  const projected = visibleElements(plan.document)
  for (let index = 0; index < projected.length; index++) {
    const element = projected[index], block = blocks[index]
    if ('table' in element && block?.kind === 'table') {
      const change = changeTableStructure(plan.document, element, block)
      plan.requests.push(...change.requests)
      plan.edits.push(...change.edits)
    }
  }
  let text = original
  for (const edit of plan.edits) {
    protectComments(text, [edit], quotes, true)
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  }
  if (text !== documentIndexedText(plan.document) || plan.requests.length > 100) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  return plan
}
