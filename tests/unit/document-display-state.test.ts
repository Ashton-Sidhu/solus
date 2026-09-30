import { describe, expect, test } from 'bun:test'
import { getSchema } from '@tiptap/core'
import { history, undoDepth } from '@tiptap/pm/history'
import { EditorState } from '@tiptap/pm/state'
import type { PlanComment } from '@solus/contracts/types'
import { documentExtensions } from '@solus/document-model/schema'
import { parseDocumentMarkdown, serializeDocumentMarkdown } from '@solus/document-model/markdown'
import {
  commentAnchor,
  commentHighlightPlugin,
  commentHighlightsKey,
  commentHighlightTransaction,
} from '@solus/workspace-ui/components/comments/lib/comment-highlights'
import { ImageSourceBinding } from '@solus/workspace-ui/components/editor/lib/document-image-view'

// Plan: docs/plans/work-editing-foundation.md §4. What one reader sees — their
// comment highlights, a signed URL for an image — is display state. It must
// never become document content, or a shared document would carry it to every
// other reader and every save would rewrite the work.

const schema = getSchema(documentExtensions())
const MARKDOWN = '# Launch\n\nThe launch date is Friday.\n\nThe budget is fixed.\n\n![Chart](asset://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png)'

function comment(id: string, selectedText: string, extra: Partial<PlanComment> = {}): PlanComment {
  return { id, selectedText, comment: 'Check this.', ...extra }
}

function initialState() {
  return EditorState.create({
    doc: schema.nodeFromJSON(parseDocumentMarkdown(MARKDOWN)),
    plugins: [history(), commentHighlightPlugin()],
  })
}

function show(state: EditorState, comments: PlanComment[]) {
  return state.apply(commentHighlightTransaction(state, { kind: 'show', anchors: comments.map(commentAnchor) }))
}

/** Position of the first text node that starts with `prefix`. */
function textStart(state: EditorState, prefix: string): number {
  let found = -1
  state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.startsWith(prefix)) found = pos
  })
  return found
}

function highlights(state: EditorState) {
  return commentHighlightsKey.getState(state)!.decorations.find().map((decoration) => ({
    id: decoration.spec.commentId,
    text: state.doc.textBetween(decoration.from, decoration.to),
    // SAFETY: an inline decoration's type carries the attrs it was made with.
    attrs: (decoration as unknown as { type: { attrs: { [name: string]: string } } }).type.attrs,
  }))
}

describe('comment highlights', () => {
  test('refreshing comments leaves the document, its markdown, and its undo history alone', () => {
    // WHY: highlights used to be marks in the document. Every refresh was then
    // a document change a shared document would send to every reader.
    let state = initialState()
    state = state.apply(state.tr.insertText('Big ', textStart(state, 'Launch')))
    const json = state.doc.toJSON()
    const markdown = serializeDocumentMarkdown(json)
    const depth = undoDepth(state)

    state = show(state, [comment('c1', 'launch date'), comment('c2', 'budget', { resolvedAt: 1 })])
    state = show(state, [comment('c1', 'launch date', { author: 'solus' })])

    expect(state.doc.toJSON()).toEqual(json)
    expect(serializeDocumentMarkdown(state.doc.toJSON())).toBe(markdown)
    expect(undoDepth(state)).toBe(depth)
  })

  test('each thread is a mark element carrying its id and its state', () => {
    const state = show(initialState(), [
      comment('open', 'launch date'),
      comment('done', 'budget', { resolvedAt: 1 }),
      comment('agent', 'Friday', { author: 'solus' }),
    ])
    expect(highlights(state)).toEqual([
      { id: 'open', text: 'launch date', attrs: { nodeName: 'mark', class: 'plan-comment-saved', 'data-plan-comment': 'open', 'data-comment-type': 'saved' } },
      { id: 'agent', text: 'Friday', attrs: { nodeName: 'mark', class: 'plan-comment-solus', 'data-plan-comment': 'agent', 'data-comment-type': 'solus' } },
      { id: 'done', text: 'budget', attrs: { nodeName: 'mark', class: 'plan-comment-resolved', 'data-plan-comment': 'done', 'data-comment-type': 'resolved' } },
    ])
  })

  test('a highlight follows edits, and a refresh keeps it on the edited text', () => {
    // WHY: the reader's own edit moved the passage. A refresh must not snap the
    // thread back to an older copy of its quote elsewhere in the document.
    let state = show(initialState(), [comment('c1', 'budget')])
    state = state.apply(state.tr.insertText('Note: ', textStart(state, 'The budget')))
    // An older copy of the quote, earlier in the text than the thread's own.
    state = state.apply(state.tr.insertText('The budget is fixed. ', textStart(state, 'The launch')))
    state = show(state, [comment('c1', 'budget', { resolvedAt: 5 })])

    const [only] = highlights(state)
    expect(only.text).toBe('budget')
    expect(only.attrs.class).toBe('plan-comment-resolved')
    const decoration = commentHighlightsKey.getState(state)!.decorations.find()[0]
    // The mapped range: in the "Note:" paragraph, not the copy inserted above.
    expect(state.doc.textBetween(decoration.from - 'Note: The '.length, decoration.to)).toBe('Note: The budget')
  })

  test('a new thread is drawn over its exact selection, and delete removes it', () => {
    let state = initialState()
    const from = textStart(state, 'The launch') + 'The '.length
    const added = comment('new', 'launch')
    state = state.apply(commentHighlightTransaction(state, { kind: 'add', anchor: commentAnchor(added), from, to: from + 'launch'.length }))
    expect(highlights(state).map((item) => item.text)).toEqual(['launch'])
    // The comment set catching up keeps the drawn range.
    state = show(state, [added])
    expect(highlights(state).map((item) => item.text)).toEqual(['launch'])
    state = state.apply(commentHighlightTransaction(state, { kind: 'remove', commentId: 'new' }))
    expect(highlights(state)).toEqual([])
  })

  test('a thread left out of the comment set loses its highlight', () => {
    let state = show(initialState(), [comment('a', 'launch'), comment('b', 'budget')])
    state = show(state, [comment('b', 'budget')])
    expect(highlights(state).map((item) => item.id)).toEqual(['b'])
  })

  test('a reloaded document finds each thread again by its quote', () => {
    let state = show(initialState(), [comment('c1', 'budget')])
    const reloaded = schema.nodeFromJSON(parseDocumentMarkdown('Intro.\n\nThe budget moved.'))
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, reloaded.content).setMeta('preventUpdate', true))
    expect(highlights(state).map((item) => item.text)).toEqual(['budget'])
  })
})

describe('image display URLs', () => {
  test('the document keeps the asset reference', () => {
    const image = parseDocumentMarkdown(MARKDOWN).content?.at(-1)
    expect(image?.attrs?.src).toStartWith('asset://')
    expect(serializeDocumentMarkdown(parseDocumentMarkdown(MARKDOWN))).toBe(MARKDOWN)
  })

  test('a signed URL that arrives after the view was destroyed is dropped', async () => {
    let answer: (url: string) => void = () => {}
    const shown: string[] = []
    const binding = new ImageSourceBinding(() => new Promise((resolve) => (answer = resolve)), (url) => shown.push(url))
    binding.setSource('asset://a.png')
    binding.destroy()
    answer('https://host/signed-a')
    await Promise.resolve()
    expect(shown).toEqual([])
  })

  test('a signed URL for an image the view no longer shows is dropped', async () => {
    const answers = new Map<string, (url: string) => void>()
    const shown: string[] = []
    const binding = new ImageSourceBinding(
      (src) => new Promise((resolve) => answers.set(src, resolve)),
      (url) => shown.push(url),
    )
    binding.setSource('asset://a.png')
    binding.setSource('asset://b.png')
    answers.get('asset://b.png')!('https://host/signed-b')
    answers.get('asset://a.png')!('https://host/signed-a')
    await Promise.resolve()
    expect(shown).toEqual(['https://host/signed-b'])
  })

  test('an ordinary URL shows at once, and a failed signature shows the reference', async () => {
    const shown: string[] = []
    new ImageSourceBinding((src) => src, (url) => shown.push(url)).setSource('https://example.com/a.png')
    expect(shown).toEqual(['https://example.com/a.png'])
    new ImageSourceBinding(() => Promise.reject(new Error('offline')), (url) => shown.push(url)).setSource('asset://c.png')
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toEqual(['https://example.com/a.png', 'asset://c.png'])
  })
})
