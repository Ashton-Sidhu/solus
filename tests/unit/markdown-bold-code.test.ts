import { expect, test } from 'bun:test'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { createMarkdownParser } from '../../packages/workspace-ui/src/components/editor/markdownParser'
import { boldTextInCodeSpan } from '../../packages/workspace-ui/src/lib/markdownBoldCode'

test('bold syntax inside a complete code span displays as bold', () => {
  // The conversation renderer uses this result, while the document editor
  // uses the same rule during parsing.
  expect(boldTextInCodeSpan('**testing**')).toBe('testing')
  expect(boldTextInCodeSpan('__testing__')).toBe('testing')

  const markdown = new MarkdownManager({ marked: createMarkdownParser(), extensions: [StarterKit] })
  const doc = markdown.parse('`**testing**`')
  expect(doc.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }])
  expect(markdown.serialize(doc)).toBe('**testing**')
})

test('plain and partial code spans keep their literal text', () => {
  expect(boldTextInCodeSpan('testing')).toBeNull()
  expect(boldTextInCodeSpan('before **testing**')).toBeNull()
  expect(boldTextInCodeSpan('**testing** after')).toBeNull()
  expect(boldTextInCodeSpan('**first**second**')).toBeNull()
  expect(boldTextInCodeSpan('***testing***')).toBeNull()

  const markdown = new MarkdownManager({ marked: createMarkdownParser(), extensions: [StarterKit] })
  const doc = markdown.parse('`ordinary`')
  expect(doc.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'code' }])
  expect(markdown.serialize(doc)).toBe('`ordinary`')
})
