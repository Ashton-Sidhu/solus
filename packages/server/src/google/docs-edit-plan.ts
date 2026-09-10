import { Marked } from 'marked'
import type { DocsRequest } from './docs-api'
import { compileDocsBlocks, type RichText, type ParagraphBlock } from './docs-requests'
import { editableDocumentSchema, UNSUPPORTED_GOOGLE_EDIT, type EditableDocument, type EditableParagraph } from './docs-edit-schema'
export { editableDocumentSchema, UNSUPPORTED_GOOGLE_EDIT, type EditableDocument }

export interface TextEdit { start: number; end: number; text: string }
interface ParagraphEdit { retained: number; edit?: TextEdit }
interface ParagraphTarget { source: EditableParagraph; target: RichText; namedStyle?: string; header?: boolean }

function supportedText(text: string): boolean {
  // Google strips these code points; accepting them would report a false sync.
  // eslint-disable-next-line no-control-regex
  return text.isWellFormed() && !/[\u0000-\u0008\u000b-\u001f\ue000-\uf8ff]/u.test(text)
}

function paragraphEdit(before: string, after: string, startIndex: number): ParagraphEdit {
  const oldPoints = Array.from(before), newPoints = Array.from(after)
  let prefix = 0, suffix = 0
  while (prefix < oldPoints.length && prefix < newPoints.length && oldPoints[prefix] === newPoints[prefix]) prefix++
  while (suffix < oldPoints.length - prefix && suffix < newPoints.length - prefix && oldPoints[oldPoints.length - 1 - suffix] === newPoints[newPoints.length - 1 - suffix]) suffix++
  if (before === after) return { retained: prefix + suffix }
  return { retained: prefix + suffix, edit: {
    start: startIndex + oldPoints.slice(0, prefix).join('').length,
    end: startIndex + oldPoints.slice(0, oldPoints.length - suffix).join('').length,
    text: newPoints.slice(prefix, newPoints.length - suffix).join(''),
  } }
}

export function paragraphText(source: EditableParagraph): string {
  let cursor = source.startIndex, text = ''
  for (const run of source.paragraph.elements) {
    if (!('textRun' in run) || run.startIndex !== cursor || run.endIndex !== cursor + run.textRun.content.length) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    text += run.textRun.content
    cursor = run.endIndex
  }
  if (cursor !== source.endIndex || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  return text.slice(0, -1)
}

/** Preserve the API's gaps between cells and objects. Quotes use real Docs
 * indexes, never offsets in a flattened markdown table. */
export function documentIndexedText(document: EditableDocument): string {
  let text = '\0'
  const append = (source: EditableParagraph) => {
    for (const run of source.paragraph.elements) {
      if (run.startIndex < text.length) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
      text += '\0'.repeat(run.startIndex - text.length)
      text += 'textRun' in run ? run.textRun.content : '\ufffc'
      if (text.length !== run.endIndex) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    }
  }
  for (const element of document.tabs[0].documentTab.body.content) {
    if ('paragraph' in element) append(element)
    else if ('table' in element) for (const row of element.table.tableRows) for (const cell of row.tableCells) for (const part of cell.content) append(part)
  }
  return text
}

export function protectComments(before: string, edits: TextEdit[], quotes: string[], allowBoundaryInsertion = false): void {
  for (const quote of quotes) {
    const start = before.indexOf(quote), end = start + quote.length
    if (!quote || start < 0 || before.indexOf(quote, start + 1) >= 0) throw new Error('A Google comment cannot be located safely. Edit this change in Google Docs.')
    if (edits.some(edit => !(allowBoundaryInsertion && edit.start === edit.end && (edit.start === start || edit.start === end)) && edit.start <= end && edit.end >= start && (edit.start <= start || edit.end >= end))) {
      throw new Error('This update removes or crosses the boundary of commented text. Edit this change in Google Docs to keep control of the comment highlight.')
    }
  }
}

function plainBlock(block: ParagraphBlock): void {
  if (block.bullet || block.baseText || block.text.text.includes('\n') || block.text.runs.some(run => run.style.code)
    || Object.keys(block.style).some(key => !['namedStyleType', 'spaceBelow'].includes(key))) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
}

function paragraphTargets(document: EditableDocument, markdown: string): ParagraphTarget[] {
  const parser = new Marked()
  parser.walkTokens(parser.lexer(markdown), token => {
    if (token.type === 'image' || token.type === 'html') throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  })
  const blocks = compileDocsBlocks(markdown, []).filter(block => block.kind !== 'paragraph' || block.text.text.trim())
  const targets: ParagraphTarget[] = []
  let index = 0
  for (const source of document.tabs[0].documentTab.body.content) {
    if ('sectionBreak' in source) continue
    if ('paragraph' in source) {
      if (source.paragraph.bullet) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
      if (source.paragraph.elements.some(run => 'inlineObjectElement' in run)) {
        // The reader omits standalone images. Preserve the original object;
        // mixed image/text paragraphs need an explicit representation first.
        if (source.paragraph.elements.some(run => 'textRun' in run && run.textRun.content.trim())) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
        continue
      }
      if (!paragraphText(source).trim()) continue
      const block = blocks[index++]
      if (!block || block.kind !== 'paragraph') throw new Error(UNSUPPORTED_GOOGLE_EDIT)
      plainBlock(block)
      targets.push({ source, target: block.text, namedStyle: block.style.namedStyleType })
      continue
    }
    const block = blocks[index++]
    if (!block || block.kind !== 'table' || source.table.rows !== block.rows.length || source.table.tableRows.length !== block.rows.length) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    for (let row = 0; row < block.rows.length; row++) {
      const cells = source.table.tableRows[row].tableCells
      if (cells.length !== source.table.columns || cells.length !== block.rows[row].length) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
      for (let column = 0; column < cells.length; column++) {
        if (cells[column].content.length !== 1) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
        targets.push({ source: cells[column].content[0], target: block.rows[row][column], header: row === 0 })
      }
    }
  }
  if (index !== blocks.length) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  return targets
}

interface InlineFormat { bold: boolean; italic: boolean; strikethrough: boolean; link: string }
function sameFormat(a: InlineFormat, b: InlineFormat): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strikethrough === b.strikethrough && a.link === b.link
}
const EMPTY_FORMAT: InlineFormat = { bold: false, italic: false, strikethrough: false, link: '' }

function sourceFormats(source: EditableParagraph, edit: TextEdit | undefined): InlineFormat[] {
  const before: InlineFormat[] = []
  for (const run of source.paragraph.elements) {
    if (!('textRun' in run)) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    const style = run.textRun.textStyle
    const value = { bold: !!style?.bold, italic: !!style?.italic, strikethrough: !!style?.strikethrough, link: style?.link?.url ?? '' }
    for (let i = run.startIndex; i < run.endIndex; i++) before.push(value)
  }
  if (edit) {
    const offset = edit.start - source.startIndex
    before.splice(offset, edit.end - edit.start, ...Array.from({ length: edit.text.length }, () => before[Math.max(0, offset - 1)] ?? EMPTY_FORMAT))
  }
  return before
}

function targetFormats(target: RichText): InlineFormat[] {
  const desired = Array.from({ length: target.text.length }, () => EMPTY_FORMAT)
  for (const run of target.runs) {
    if (run.style.code) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    for (let i = run.start; i < run.end; i++) desired[i] = { bold: !!run.style.bold, italic: !!run.style.italic, strikethrough: !!run.style.strikethrough, link: run.style.link ?? '' }
  }
  return desired
}

function styleRequests(item: ParagraphTarget, edit: TextEdit | undefined, tabId: string): DocsRequest[] {
  const { source, target } = item
  const before = sourceFormats(source, edit)
  const desired = targetFormats(target)
  const requests: DocsRequest[] = []
  for (let start = 0; start < desired.length;) {
    const value = desired[start], old = before[start] ?? EMPTY_FORMAT
    // Heading and table-header bold is implicit in the markdown reader.
    const implicitBold = (item.header && !value.bold) || (item.namedStyle !== undefined && item.namedStyle !== 'NORMAL_TEXT')
    const compared = implicitBold ? { ...value, bold: old.bold } : value
    const isInserted = edit && source.startIndex + start >= edit.start && source.startIndex + start < edit.start + edit.text.length
    if (!isInserted && sameFormat(old, compared)) { start++; continue }
    let end = start + 1
    while (end < desired.length && sameFormat(value, desired[end])) end++
    const textStyle = { bold: compared.bold, italic: value.italic, strikethrough: value.strikethrough }
    const fields = implicitBold ? 'italic,strikethrough,link' : 'bold,italic,strikethrough,link'
    requests.push({ updateTextStyle: { range: { startIndex: source.startIndex + start, endIndex: source.startIndex + end, tabId }, textStyle: value.link ? { ...textStyle, link: { url: value.link } } : textStyle, fields } })
    start = end
  }
  if (item.namedStyle && item.namedStyle !== (source.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT')) {
    requests.push({ updateParagraphStyle: { range: { startIndex: source.startIndex, endIndex: source.startIndex + target.text.length + 1, tabId }, paragraphStyle: { namedStyleType: item.namedStyle }, fields: 'namedStyleType' } })
  }
  return requests
}

/** Edits run from the end of the document. Each paragraph's formatting uses
 * its indexes after its text edit, before any earlier paragraph moves it. */
export function planGoogleDocEdit(document: EditableDocument, markdown: string, quotes: string[]): DocsRequest[] {
  const targets = paragraphTargets(document, markdown)
  const edits: TextEdit[] = [], requests: DocsRequest[] = []
  const tabId = document.tabs[0].tabProperties.tabId
  let retained = 0
  for (const item of targets.reverse()) {
    if (!supportedText(item.target.text)) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    const change = paragraphEdit(paragraphText(item.source), item.target.text, item.source.startIndex)
    retained += change.retained
    const edit = change.edit
    if (edit) {
      edits.push(edit)
      if (edit.end > edit.start) requests.push({ deleteContentRange: { range: { startIndex: edit.start, endIndex: edit.end, tabId } } })
      if (edit.text) requests.push({ insertText: { location: { index: edit.start, tabId }, text: edit.text } })
    }
    requests.push(...styleRequests(item, edit, tabId))
  }
  if (edits.length) {
    if (!retained || edits.length > 100) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
    protectComments(documentIndexedText(document), edits, quotes)
  }
  if (requests.length > 500) throw new Error(UNSUPPORTED_GOOGLE_EDIT)
  return requests
}
