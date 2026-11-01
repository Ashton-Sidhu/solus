import { expect, test } from 'bun:test'
import { settledMarkdownBlocks } from '@solus/workspace-ui/components/conversation/lib/settled-markdown'
import { assistantMarkdownExtensions } from '@solus/workspace-ui/components/conversation/lib/assistant-markdown'

const blocksOf = (source: string) => settledMarkdownBlocks(source, assistantMarkdownExtensions(source))

test('a finished reply writes its plain blocks as HTML and keeps our renderers for the rest', () => {
  // WHY: one component per markdown token was most of a reply's mount when a
  // session opened. Plain prose is the same markup as HTML; code, links,
  // images, tables, and headings still need our components
  // (docs/plans/session-open-performance.md).
  const source = 'The reducer keeps **state** & checks "x".\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n\nSee [the docs](https://example.com).\n\n> quoted'
  const blocks = blocksOf(source)!
  expect(blocks.map((block) => 'html' in block ? 'html' : (block.tokens.map((token) => token.type).join('+')))).toEqual(['html', 'code+space+paragraph+space', 'html'])
  const first = blocks[0]
  if (!('html' in first)) throw new Error('expected html')
  // Text is escaped: a reply cannot inject markup through plain prose.
  expect(first.html).toContain('&amp; checks &quot;x&quot;')
  expect(first.html).toContain('<strong>state</strong>')
  expect(first.html).toContain('<li>one</li>')
})

test('replies that need the whole reply, or render differently in HTML, are not split as plain', () => {
  // Raw HTML and footnotes cross blocks; a loose list and a task item render
  // differently in marked than in the markdown component.
  expect(blocksOf('Hello <b>there</b>\n\n<div>block</div>')).toBeNull()
  expect(blocksOf('A claim.[^1]\n\n[^1]: The source.')).toBeNull()
  expect(blocksOf('- one\n\n- two')!.every((block) => 'tokens' in block)).toBe(true)
  expect(blocksOf('- [ ] todo')!.every((block) => 'tokens' in block)).toBe(true)
})

test('a finished reply that mounts again reuses its lexed blocks, and a very long reply is not kept', () => {
  // WHY: ConversationPool unmounts older conversations; lexing a 50 KB reply
  // again on each return cost about 280 ms. The cache is bounded, so one huge
  // reply cannot push every other reply out.
  const source = 'A reply with **bold** text and `code`.\n\n```ts\nconst x = 1\n```\n'
  const extensions = assistantMarkdownExtensions(source)
  const first = settledMarkdownBlocks(source, extensions)
  expect(settledMarkdownBlocks(source, extensions)).toBe(first)
  // Another extension set is another entry.
  expect(settledMarkdownBlocks(source, assistantMarkdownExtensions('<b>x</b>'))).not.toBe(first)
  const huge = 'word '.repeat(30_000)
  expect(settledMarkdownBlocks(huge, extensions)).not.toBe(settledMarkdownBlocks(huge, extensions))
})

test('the reply cache drops its least recently used reply when it is full', () => {
  const extensions = assistantMarkdownExtensions('')
  const kept = 'kept reply\n'
  const keptBlocks = settledMarkdownBlocks(kept, extensions)
  const dropped = 'dropped reply\n'
  const droppedBlocks = settledMarkdownBlocks(dropped, extensions)
  // About 600K characters of other replies: past the 500K budget.
  for (let i = 0; i < 6; i++) {
    expect(settledMarkdownBlocks(kept, extensions)).toBe(keptBlocks)
    settledMarkdownBlocks(`${i} ${'filler '.repeat(14_000)}`, extensions)
  }
  expect(settledMarkdownBlocks(kept, extensions)).toBe(keptBlocks)
  expect(settledMarkdownBlocks(dropped, extensions)).not.toBe(droppedBlocks)
})
