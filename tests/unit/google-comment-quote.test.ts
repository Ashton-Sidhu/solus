import { expect, test } from 'bun:test'
import { Schema } from '@tiptap/pm/model'
import { googleQuoteRange } from '../../packages/workspace-ui/src/components/work/lib/google-comment-quote'
const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } } })
function doc(text: string) { return schema.node('doc', null, [schema.node('paragraph', null, schema.text(text))]) }
test('locates a unique quote, refuses missing, empty, or repeated text', () => {
  expect(googleQuoteRange(doc('Blue herons rest.'), 'herons')).toEqual({ from: 6, to: 12 })
  expect(googleQuoteRange(doc('Blue Blue'), 'Blue')).toBeNull()
  expect(googleQuoteRange(doc('Blue'), 'Red')).toBeNull()
  expect(googleQuoteRange(doc('Blue'), '')).toBeNull()
})
