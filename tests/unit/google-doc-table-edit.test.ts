import { expect, test } from 'bun:test'
import { documentIndexedText, editableDocumentSchema, planGoogleDocEdit } from '@solus/server/google/docs-edit-plan'
import type { DocsRequest } from '@solus/server/google/docs-api'

function fixture() {
  let cursor = 1
  const paragraph = (text: string) => {
    const startIndex = cursor
    cursor += text.length + 1
    return { startIndex, endIndex: cursor, paragraph: { elements: [{ startIndex, endIndex: cursor, textRun: { content: text + '\n' } }] } }
  }
  const before = paragraph('Before old.'), blank = paragraph(''), startIndex = cursor++
  const tableRows = [['Name', 'Date'], ['Launch', 'The date is Friday.']].map(row => {
    cursor++
    return { tableCells: row.map(text => { const startIndex = cursor++; const content = [paragraph(text)]; return { startIndex, endIndex: cursor, content, tableCellStyle: { rowSpan: 1, columnSpan: 1 } } }) }
  })
  const table = { startIndex, endIndex: cursor, table: { rows: 2, columns: 2, tableRows } }
  const after = paragraph('After old.'), final = paragraph('')
  return editableDocumentSchema.parse({ revisionId: 'r1', tabs: [{ tabProperties: { tabId: 'tab' }, documentTab: { body: { content: [before, blank, table, after, final] } } }] })
}
const markdown = 'Before old.\n\n| Name | Date |\n| --- | --- |\n| Launch | The date is Friday. |\n\nAfter old.'
function apply(text: string, requests: DocsRequest[]): string {
  for (const request of requests) {
    if ('deleteContentRange' in request) { const { startIndex, endIndex } = request.deleteContentRange.range; text = text.slice(0, startIndex) + text.slice(endIndex) }
    if ('insertText' in request) { const { location, text: added } = request.insertText; text = text.slice(0, location.index) + added + text.slice(location.index) }
  }
  return text
}
test('unchanged table is a no-op and edits around it preserve cell text and structural gaps', () => {
  const doc = fixture(), before = documentIndexedText(doc)
  expect(planGoogleDocEdit(doc, markdown, [])).toEqual([])
  const requests = planGoogleDocEdit(doc, markdown.replaceAll('old.', 'new.'), ['The date is Friday.'])
  expect(apply(before, requests)).toBe(before.replaceAll('old.', 'new.'))
})
test('review inside a table cell uses native indexes and keeps cell and quote boundaries', () => {
  const doc = fixture(), before = documentIndexedText(doc)
  const requests = planGoogleDocEdit(doc, markdown.replace('Friday', 'Monday'), ['The date is Friday.'])
  expect(apply(before, requests)).toBe(before.replace('Friday', 'Monday'))
  expect(() => planGoogleDocEdit(doc, markdown.replace('The date is Friday.', 'Gone.'), ['The date is Friday.'])).toThrow('comment')
})
test('table shape, merged cells and nested structure cannot silently disappear', () => {
  expect(() => planGoogleDocEdit(fixture(), markdown.replace('| Launch | The date is Friday. |', '| Launch | The date is Friday. |\n| Other | Tuesday |'), [])).toThrow('not supported')
  const doc = fixture(), table = doc.tabs[0].documentTab.body.content.find(element => 'table' in element)
  if (!table || !('table' in table)) throw new Error('Missing fixture table')
  const cell = table.table.tableRows[0].tableCells[0]
  expect(editableDocumentSchema.safeParse(JSON.parse(JSON.stringify(doc).replace('"rowSpan":1', '"rowSpan":2'))).success).toBe(false)
  cell.content.push(cell.content[0])
  expect(() => planGoogleDocEdit(doc, markdown, [])).toThrow('not supported')
})
test('formatting changes never delete text or reset unrelated paragraph properties', () => {
  const requests = planGoogleDocEdit(fixture(), markdown.replace('Before old.', '# Before **old**.').replace('The date is Friday.', 'The date is *Friday*.'), [])
  expect(requests.some(request => 'deleteContentRange' in request || 'insertText' in request)).toBe(false)
  expect(requests.some(request => 'updateParagraphStyle' in request && request.updateParagraphStyle.fields === 'namedStyleType')).toBe(true)
  expect(requests.some(request => 'updateTextStyle' in request && request.updateTextStyle.textStyle.italic)).toBe(true)
})
test('standalone images remain in place while supported text changes', () => {
  const doc = editableDocumentSchema.parse({ revisionId: 'r1', tabs: [{ tabProperties: { tabId: 'tab' }, documentTab: { body: { content: [
    { startIndex: 1, endIndex: 3, paragraph: { elements: [{ startIndex: 1, endIndex: 2, inlineObjectElement: { inlineObjectId: 'original-image' } }, { startIndex: 2, endIndex: 3, textRun: { content: '\n' } }] } },
    { startIndex: 3, endIndex: 12, paragraph: { elements: [{ startIndex: 3, endIndex: 12, textRun: { content: 'Old day.\n' } }] } },
  ] } } }] })
  const requests = planGoogleDocEdit(doc, 'Old days.', [])
  expect(apply(documentIndexedText(doc), requests)).toBe('\0\ufffc\nOld days.\n')
})

test('unsupported image insertion is refused before its alt text can become a cell value', () => {
  expect(() => planGoogleDocEdit(fixture(), markdown.replace('Launch', '![Launch](https://example.com/image.png)'), [])).toThrow('not supported')
})
test('an unprotected cell value can change completely without replacing its paragraph or table', () => {
  const doc = fixture(), before = documentIndexedText(doc)
  const requests = planGoogleDocEdit(doc, markdown.replace('Launch', 'Release'), [])
  expect(apply(before, requests)).toBe(before.replace('Launch', 'Release'))
  for (const request of requests) if ('deleteContentRange' in request) {
    const range = request.deleteContentRange.range
    expect(before.slice(range.startIndex, range.endIndex)).not.toMatch(/[\n\0]/)
  }
})
