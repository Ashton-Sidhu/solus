import { describe, expect, test } from 'bun:test'
import {
  HTML_SOURCE_INFO,
  htmlBlockFence,
  parseFence,
  serializeHtmlBlock,
} from '../../packages/workspace-ui/src/components/editor/lib/html-block-fence'

/** What a document holds after parsing and writes back on save. Mirrors the
 *  node's two attributes so the round trip can be asserted without an editor. */
function roundTrip(markdown: string): string {
  const block = htmlBlockFence(markdown)
  if (!block) return markdown
  return serializeHtmlBlock(block.html, block.explicit)
}

describe('an HTML block in a document', () => {
  test('round-trips byte for byte', () => {
    // WHY: the document's markdown is the file. A round trip that adds or drops
    // a newline rewrites every document containing a render the moment it is
    // opened, and every one of those edits shows up as a diff nobody made.
    const markdown = '```html\n<style>b{color:red}</style>\n<b>Hi</b>\n```'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  test('a hand-rendered snippet keeps the word that made it one', () => {
    // WHY: `render` is the reader's choice recorded in the content. Dropping it
    // would make the block a snippet again on the next open — the choice would
    // not survive one save.
    const markdown = '```html render\n<div>plain</div>\n```'
    const block = htmlBlockFence(markdown)

    expect(block?.explicit).toBe(true)
    expect(roundTrip(markdown)).toBe(markdown)
  })

  test('a snippet is not claimed, so the built-in code block keeps it', () => {
    // WHY: the tokenizer runs before marked's own fence rule. Claiming a
    // snippet would replace a readable code block with an empty frame.
    expect(htmlBlockFence('```html\n<div>plain</div>\n```')).toBeNull()
    expect(htmlBlockFence('```html source\n<style>b{color:red}</style>\n```')).toBeNull()
    expect(htmlBlockFence('```ts\nconst a = 1\n```')).toBeNull()
  })

  test('an unclosed fence is left alone', () => {
    // WHY: while a block is being typed, or while an agent streams a document
    // into the editor, the fence is open. A frame must not appear until it
    // closes, and the text must stay editable in the meantime.
    expect(htmlBlockFence('```html\n<style>b{color:red}</style>\n')).toBeNull()
    expect(parseFence('```html\n<style>x</style>\n')).toBeNull()
  })

  test('a trailing blank line inside the fence survives', () => {
    const markdown = '```html\n<style>b{color:red}</style>\n\n```'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  test('the closing delimiter must match the opening width', () => {
    // WHY: a four-backtick fence exists so a three-backtick line inside it is
    // content. Closing early would cut the render in half.
    const markdown = '````html\n<style>b{color:red}</style>\n```\n````'
    expect(htmlBlockFence(markdown)?.html).toBe('<style>b{color:red}</style>\n```')
  })

  test('reading a block as code writes a fence that stays code', () => {
    // WHY: "Show as code" and Render are each other's reverse. Without the
    // word, the next parse would render the block again and the reader could
    // never get back to the source.
    expect(HTML_SOURCE_INFO).toBe('html source')
    expect(htmlBlockFence('```html source\n<style>b{}</style>\n```')).toBeNull()
  })
})

test('HTML containing fence delimiters survives save and reopen', () => {
  for (const delimiter of ['````', '~~~~~']) {
    const html = '<script>\nconst example = `\n```\n~~~~\n`;\n</script>\n'
    const parsed = htmlBlockFence(`${delimiter}html\n${html}\n${delimiter}`)!
    const reopened = htmlBlockFence(serializeHtmlBlock(parsed.html, parsed.explicit))
    expect(reopened?.html).toBe(html)
  }
})

test('a closing fence must occupy its own line and use the same character', () => {
  expect(parseFence('```html\n<style>b{}</style>```\n')).toBeNull()
  expect(parseFence('```html\n<style>b{}</style>\n```~\n')).toBeNull()
  expect(parseFence('~~~html\n<style>b{}</style>\n~~~`\n')).toBeNull()
})
