import { describe, expect, test } from 'bun:test'
import { isOpenableUrl, parseInline, parseMarkdown } from '../../apps/mobile/src/features/conversation/lib/markdown'

describe('native transcript markdown', () => {
  test('separates code fences, headings, lists, quotes, and paragraphs', () => {
    const blocks = parseMarkdown('# Plan\n\nFirst line\nsecond line\n\n- one\n- two\n1. a\n> note\n```ts\nconst x = 1\n```')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code'])
    expect(blocks[5]).toEqual({ kind: 'code', language: 'ts', text: 'const x = 1' })
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }]] })
  })

  test('an unclosed fence while text streams is still code', () => {
    expect(parseMarkdown('```\nhalf')).toEqual([{ kind: 'code', language: '', text: 'half' }])
  })

  test('inline code, emphasis, and links', () => {
    expect(parseInline('Run `bun test` **now**, see [docs](https://solus.sh) or *later*')).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'bun test' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'now' },
      { kind: 'text', text: ', see ' },
      { kind: 'link', text: 'docs', url: 'https://solus.sh' },
      { kind: 'text', text: ' or ' },
      { kind: 'em', text: 'later' },
    ])
  })

  test('only web and mail links open on the phone', () => {
    expect(isOpenableUrl('https://solus.sh')).toBe(true)
    expect(isOpenableUrl('plan://ref?planId=x')).toBe(false)
    expect(isOpenableUrl('/Users/ada/file.ts')).toBe(false)
  })
})
