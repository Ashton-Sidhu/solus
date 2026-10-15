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
