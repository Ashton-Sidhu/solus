import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { getSchema } from '@tiptap/core'
import { DOMParser, DOMSerializer } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { CommentMark } from '@solus/workspace-ui/components/editor/commentMark'

/**
 * ProseMirror re-reads a mark from its own DOM whenever something outside the
 * editor mutates that DOM. The comments rail does exactly that when it lights
 * a highlight: it toggles a class on every element of the mark. When the quote
 * crosses a node boundary — inline code splits it in two — the re-read spans
 * both elements and rebuilds the mark from scratch, so what the mark parses
 * back from its DOM is what the thread keeps. Lose the id here and the rail
 * can no longer find the highlight, and the thread falls out of the margin.
 */
test('a comment mark re-read from its own DOM keeps its thread id and state', () => {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>')
  const schema = getSchema([StarterKit, CommentMark])
  const comment = schema.marks.planComment.create({ commentId: 'thread-1', type: 'resolved' })
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('T3 adds a setting for ', [comment]),
      schema.text('Cmd+Enter', [schema.marks.code.create()]),
      schema.text(' as the send key.', [comment]),
    ]),
  ])

  const dom = DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: window.document })
  const highlight = Array.from(dom.querySelectorAll('mark'))
  expect(highlight).toHaveLength(2)
  for (const element of highlight) element.classList.add('plan-comment-active')

  const parsed = DOMParser.fromSchema(schema).parse(dom)
  // The exact test the editor applies: an equal document is left alone, an
  // unequal one is replaced by what was parsed.
  expect(parsed.eq(doc)).toBe(true)
})
