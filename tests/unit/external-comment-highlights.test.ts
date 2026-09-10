import { expect, test } from 'bun:test'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { externalCommentHighlightPlugin, externalHighlightsKey, externalHighlightInput } from '../../packages/workspace-ui/src/components/work/lib/external-comment-highlights'
import type { WorkExternalComments, DocCommentThread } from '@solus/contracts/work-comments'

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } } })
function state(text = 'The launch date is Friday.') {
  return EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph', null, schema.text(text))]), plugins: [externalCommentHighlightPlugin()] })
}
function sync(current: EditorState, quotes = [{ threadId: 'inline:1', quote: 'The launch date is Friday.' }], target = 'page-1') {
  return current.apply(current.tr.setMeta(externalHighlightsKey, { target, quotes }).setMeta('addToHistory', false))
}
function ranges(current: EditorState) { return externalHighlightsKey.getState(current)!.decorations.find() }

function snapshot(provider: WorkExternalComments['provider']): WorkExternalComments {
  const thread: DocCommentThread = { id: 'review-1', textAnchor: { quote: 'The launch date is Friday.', attachmentState: 'unknown' }, quote: 'The launch date is Friday.', text: 'Change Friday to Monday.', author: { name: 'Reviewer', isMe: false }, createdAt: '', modifiedAt: '', resolved: false, deleted: false, replies: [] }
  return { provider, documentId: 'doc-1', externalKey: 'site-1', threads: [thread], operations: [] }
}

test('Google quoted comments highlight without Confluence location metadata and follow refreshed state', () => {
  const google = snapshot('gdrive')
  let current = state()
  const refresh = () => { current = current.apply(current.tr.setMeta(externalHighlightsKey, externalHighlightInput(google, 'work-1'))) }
  refresh()
  expect(ranges(current)).toHaveLength(1)
  current = current.apply(current.tr.insertText('Monday', 20, 26))
  google.threads[0].textAnchor!.quote = 'The launch date is Monday.'
  refresh()
  const range = ranges(current)[0]
  expect(current.doc.textBetween(range.from, range.to)).toBe('The launch date is Monday.')
  google.threads[0].resolved = true
  refresh()
  expect(ranges(current)).toHaveLength(0)
  google.threads[0].resolved = false
  refresh()
  expect(ranges(current)).toHaveLength(1)
  google.threads[0].deleted = true
  refresh()
  expect(ranges(current)).toHaveLength(0)
})

test('highlight eligibility depends on adapter anchor metadata, not provider identity', () => {
  const confluence = snapshot('confluence')
  delete confluence.threads[0].textAnchor
  expect(externalHighlightInput(confluence).quotes).toHaveLength(0)
  confluence.threads[0].textAnchor = { quote: 'The launch date is Friday.', attachmentState: 'unknown' }
  expect(externalHighlightInput(confluence).quotes).toHaveLength(1)
  const google = snapshot('gdrive')
  expect(externalHighlightInput(google).target).not.toBe(externalHighlightInput(confluence).target)
  google.threads[0].textAnchor!.attachmentState = 'detached'
  expect(externalHighlightInput(google).quotes).toHaveLength(0)
  google.threads[0].textAnchor!.attachmentState = 'unknown'
  google.threads[0].textAnchor!.quote = ''
  expect(externalHighlightInput(google).quotes).toHaveLength(0)
  expect(externalHighlightInput().quotes).toHaveLength(0)
})

test('imports a persistent unique highlight without changing document content', () => {
  const initial = state()
  const highlighted = sync(initial)
  expect(ranges(highlighted).map(range => [range.from, range.to])).toEqual([[1, 27]])
  expect(highlighted.doc.toJSON()).toEqual(initial.doc.toJSON())
  expect(ranges(highlighted.apply(highlighted.tr)).length).toBe(1)
})

test('does not guess between repeated or missing quotes', () => {
  expect(ranges(sync(state('The launch date is Friday. The launch date is Friday.')))).toHaveLength(0)
  expect(ranges(sync(state('The launch date is Monday.')))).toHaveLength(0)
})

test('local edits map the highlighted range and comment refresh retains the edited text', () => {
  let current = sync(state())
  const start = current.doc.textContent.indexOf('Friday') + 1
  current = current.apply(current.tr.insertText('Monday', start, start + 6))
  current = sync(current)
  const range = ranges(current)[0]
  expect(current.doc.textBetween(range.from, range.to)).toBe('The launch date is Monday.')
  current = current.apply(current.tr.insertText('Note: ', 1))
  expect(ranges(current)[0].from).toBe(7)
})

test('removed comments clear highlights and relinking cannot retain old mapped ranges', () => {
  const current = sync(state())
  expect(ranges(sync(current, []))).toHaveLength(0)
  const edited = current.apply(current.tr.insertText('Monday', 20, 26))
  expect(ranges(sync(edited, undefined, 'page-2'))).toHaveLength(0)
})

test('deleting a highlighted range removes it and refresh never reattaches to another occurrence', () => {
  let current = sync(state())
  current = current.apply(current.tr.delete(1, 27))
  current = current.apply(current.tr.insertText('The launch date is Friday.', 1))
  expect(ranges(sync(current))).toHaveLength(0)
})

test('an external document reset rechecks quotes against the new content', () => {
  const current = sync(state('No matching quote yet.'))
  const reset = current.apply(current.tr.replaceWith(0, current.doc.content.size, state().doc.content).setMeta('preventUpdate', true))
  expect(ranges(reset)).toHaveLength(1)
})
