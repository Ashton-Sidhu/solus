import { expect, test } from 'bun:test'
import { editableDocumentSchema, documentIndexedText, planGoogleDocEdit } from '@solus/server/google/docs-edit-plan'
import { planGoogleDocStructure } from '@solus/server/google/docs-structure-plan'
import { reindexDocument } from '@solus/server/google/docs-structure-model'

function fixture() {
  const paragraph = (text: string) => ({ startIndex: 0, endIndex: 0, paragraph: { elements: [{ startIndex: 0, endIndex: 0, textRun: { content: text + '\n' } }] } })
  const document = editableDocumentSchema.parse({ revisionId: 'r', tabs: [{ tabProperties: { tabId: 'tab' }, documentTab: { body: { content: [
    paragraph('Before.'), paragraph(''),
    { startIndex: 0, endIndex: 0, table: { rows: 3, columns: 2, tableRows: [['Name', 'Day'], ['Launch', 'Friday'], ['Review', 'Monday']].map(values => ({ tableCells: values.map(text => ({ startIndex: 0, endIndex: 0, content: [paragraph(text)] })) })) } },
    paragraph('After.'), paragraph(''),
  ] } } }] })
  reindexDocument(document)
  return document
}
const original = 'Before.\n\n| Name | Day |\n| --- | --- |\n| Launch | Friday |\n| Review | Monday |\n\nAfter.'
function tableOf(document: ReturnType<typeof fixture>) {
  const element = document.tabs[0].documentTab.body.content.find(element => 'table' in element)
  if (!element || !('table' in element)) throw new Error('No table')
  return element.table
}

test('row additions retain original cell text and plan a dedicated operation followed by cell fills', () => {
  const document = fixture(), before = documentIndexedText(document)
  const target = original.replace('| Review | Monday |', '| Prep | Tuesday |\n| Review | Monday |')
  const plan = planGoogleDocStructure(document, target, ['Friday'])
  expect(plan.requests.filter(request => 'insertTableRow' in request)).toHaveLength(1)
  expect(tableOf(plan.document).rows).toBe(4)
  expect(documentIndexedText(document)).toBe(before)
  expect(planGoogleDocEdit(plan.document, target, ['Friday']).some(request => 'insertText' in request && request.insertText.text === 'Tuesday')).toBe(true)
})
test('column additions retain rows and support more than one contiguous new column', () => {
  const target = 'Before.\n\n| Name | Owner | State | Day |\n| --- | --- | --- | --- |\n| Launch | Maya | Ready | Friday |\n| Review | Lee | Open | Monday |\n\nAfter.'
  const plan = planGoogleDocStructure(fixture(), target, ['Friday'])
  expect(plan.requests.filter(request => 'insertTableColumn' in request)).toHaveLength(2)
  expect(tableOf(plan.document).columns).toBe(4)
  expect(() => planGoogleDocEdit(plan.document, target, ['Friday'])).not.toThrow()
})
test('row and column deletion refuse to remove a comment target before any write', () => {
  const removeRow = original.replace('| Launch | Friday |\n', '')
  expect(() => planGoogleDocStructure(fixture(), removeRow, ['Friday'])).toThrow('comment')
  expect(planGoogleDocStructure(fixture(), removeRow, ['Monday']).requests.some(request => 'deleteTableRow' in request)).toBe(true)
  const removeColumn = 'Before.\n\n| Name |\n| --- |\n| Launch |\n| Review |\n\nAfter.'
  expect(() => planGoogleDocStructure(fixture(), removeColumn, ['Friday'])).toThrow('comment')
  expect(planGoogleDocStructure(fixture(), removeColumn, ['Before.']).requests.some(request => 'deleteTableColumn' in request)).toBe(true)
})
test('paragraph insertion and removal preserve tables, comments and the mandatory final newline', () => {
  for (const target of [original.replace('After.', 'New paragraph.\n\nAfter.'), original + '\n\nLast paragraph.', original.replace('After.', '')]) {
    const plan = planGoogleDocStructure(fixture(), target, ['Friday'])
    expect(() => planGoogleDocEdit(plan.document, target, ['Friday'])).not.toThrow()
    expect(documentIndexedText(plan.document).endsWith('\n')).toBe(true)
    expect(tableOf(plan.document).rows).toBe(3)
  }
  expect(() => planGoogleDocStructure(fixture(), original.replace('After.', ''), ['After.'])).toThrow('comment')
})
test('ambiguous or mixed structural edits cannot delete and recreate the table', () => {
  const target = original.replace('| Launch | Friday |', '| Other | Tuesday |').replace('| Review | Monday |', '')
  expect(() => planGoogleDocStructure(fixture(), target, [])).toThrow('matched safely')
  expect(() => planGoogleDocStructure(fixture(), original.replace('| Launch | Friday |', '| Launch | Friday |\n| Launch | Friday |'), [])).toThrow('matched safely')
})

test('append without a spare final paragraph retains the original final newline', () => {
  const document = fixture()
  document.tabs[0].documentTab.body.content.pop()
  reindexDocument(document)
  const target = original + '\n\nLast paragraph.'
  const plan = planGoogleDocStructure(document, target, ['After.'])
  expect(documentIndexedText(plan.document).endsWith('After.\nLast paragraph.\n')).toBe(true)
  expect(() => planGoogleDocEdit(plan.document, target, ['After.'])).not.toThrow()
})

test('a paragraph can be inserted before a table without deleting its required boundary paragraph', () => {
  const target = original.replace('| Name', 'Table introduction.\n\n| Name')
  const plan = planGoogleDocStructure(fixture(), target, ['Before.'])
  expect(plan.requests.some(request => 'deleteContentRange' in request)).toBe(false)
  expect(() => planGoogleDocEdit(plan.document, target, ['Before.'])).not.toThrow()
})
