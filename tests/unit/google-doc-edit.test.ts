import { expect, test } from 'bun:test'
import { editableDocumentSchema, planGoogleDocEdit } from '@solus/server/google/docs-edit-plan'
import type { DocsRequest } from '@solus/server/google/docs-api'

function fixture(lines: string[]) {
  let cursor = 1
  return {
    revisionId: 'revision-1',
    tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: lines.map(line => {
      const text = line + '\n', startIndex = cursor
      cursor += text.length
      return { startIndex, endIndex: cursor, paragraph: { elements: [{ startIndex, endIndex: cursor, textRun: { content: text } }] } }
    }) } } }],
  }
}
function apply(text: string, requests: DocsRequest[]) {
  for (const request of requests) {
    if ('deleteContentRange' in request) {
      const range = request.deleteContentRange.range
      expect(range.tabId).toBe('tab-1')
      text = text.slice(0, range.startIndex - 1) + text.slice(range.endIndex - 1)
    } else if ('insertText' in request) {
      const { location, text: added } = request.insertText
      expect(location.tabId).toBe('tab-1')
      text = text.slice(0, location.index - 1) + added + text.slice(location.index - 1)
    } else expect('updateTextStyle' in request || 'updateParagraphStyle' in request).toBe(true)
  }
  return text
}

test('updates only changed text and keeps paragraph boundaries, Unicode and final newline', () => {
  const document = editableDocumentSchema.parse(fixture(['First 😀 day.', 'Last old day.', '']))
  const requests = planGoogleDocEdit(document, 'First 😁 day.\n\nLast new day.', [])
  expect(apply('First 😀 day.\nLast old day.\n\n', requests)).toBe('First 😁 day.\nLast new day.\n\n')
  for (const request of requests) if ('deleteContentRange' in request) {
    const { startIndex, endIndex } = request.deleteContentRange.range
    expect('First 😀 day.\nLast old day.\n\n'.slice(startIndex - 1, endIndex - 1)).not.toContain('\n')
  }
})

test('unchanged content sends no requests, including a comment with an unavailable quote', () => {
  expect(planGoogleDocEdit(fixture(['Keep this.', '']), 'Keep this.', [''])).toEqual([])
})

test('never substitutes full-body replacement or paragraph replacement for unsupported changes', () => {
  for (const markdown of ['Entirely different', 'Keep this.\n\nNew paragraph.', '| A | B |\n| - | - |\n| 1 | 2 |']) {
    expect(() => planGoogleDocEdit(fixture(['Keep this.', '']), markdown, [])).toThrow('not supported')
  }
})

test('edits outside a comment leave the quoted range untouched', () => {
  const requests = planGoogleDocEdit(fixture(['Before old.', 'Protected sentence.', 'After old.', '']), 'Before new.\n\nProtected sentence.\n\nAfter new.', ['Protected sentence.'])
  expect(apply('Before old.\nProtected sentence.\nAfter old.\n\n', requests)).toBe('Before new.\nProtected sentence.\nAfter new.\n\n')
})

test('addressing a review edits inside the quoted sentence and retains its boundary text', () => {
  const before = 'The launch date is Friday.\nThe project owner is Maya.\n\n'
  const requests = planGoogleDocEdit(fixture(['The launch date is Friday.', 'The project owner is Maya.', '']), 'The launch date is Monday.\n\nThe project owner is Maya.', ['The launch date is Friday.'])
  expect(apply(before, requests)).toBe('The launch date is Monday.\nThe project owner is Maya.\n\n')
  const deletions = requests.flatMap(request => 'deleteContentRange' in request ? [request.deleteContentRange.range] : [])
  expect(deletions).toHaveLength(1)
  expect(before.slice(deletions[0].startIndex - 1, deletions[0].endIndex - 1)).toBe('Fri')
})

test('comment overlap, boundary insertion, missing and repeated quotes stop before writing', () => {
  for (const quote of ['Keep', '', 'Missing', 'e']) {
    expect(() => planGoogleDocEdit(fixture(['Keep this.', '']), 'Keeps this.', [quote])).toThrow(/comment/)
  }
})

test('unsupported body structures and suggestions cannot disappear through parsing', () => {
  const base = fixture(['Keep this.'])
  const tab = base.tabs[0]
  const element = tab.documentTab.body.content[0]
  for (const bad of [
    { ...base, revisionId: undefined },
    { ...base, tabs: [tab, tab] },
    { ...base, tabs: [{ ...tab, childTabs: [tab] }] },
    { ...base, tabs: [{ ...tab, documentTab: { body: { content: [{ startIndex: 1, endIndex: 4, table: {} }] } } }] },
    { ...base, tabs: [{ ...tab, documentTab: { body: { content: [{ ...element, paragraph: { ...element.paragraph, elements: [{ ...element.paragraph.elements[0], suggestedInsertionIds: ['suggestion'] }] } }] } } }] },
  ]) expect(editableDocumentSchema.safeParse(bad).success).toBe(false)
})
