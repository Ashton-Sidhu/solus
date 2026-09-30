import { describe, expect, test } from 'bun:test'
import { Marked, type Token } from 'marked'
import {
  ALERT_TOKEN,
  FOOTNOTE_REF_TOKEN,
  FOOTNOTE_SECTION_TOKEN,
  alertMarkedExtension,
  footnoteMarkedExtension,
} from '../../packages/workspace-ui/src/components/conversation/lib/markdown-extensions'
import { assistantMarkdownExtensions } from '../../packages/workspace-ui/src/components/conversation/lib/assistant-markdown'

function lex(src: string): Token[] {
  return new Marked(alertMarkedExtension, footnoteMarkedExtension).lexer(src)
}

function flatten(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => [token, ...flatten(('tokens' in token && token.tokens) || [])])
}

describe('GitHub alerts in a reply', () => {
  test('an alert keeps its type and its markdown body without the quote markers', () => {
    // WHY: the body is parsed again as markdown, so a leftover `>` would turn
    // every alert into a blockquote inside the alert.
    const [alert, after] = lex('> [!WARNING]\n> Run `bun install` first.\n> Then [read](https://x.dev).\n\nAfter.')
    expect(alert).toMatchObject({ type: ALERT_TOKEN, alertType: 'warning', text: 'Run `bun install` first.\nThen [read](https://x.dev).' })
    expect(after.type).toBe('paragraph')
  })

  test('an unknown alert type stays an ordinary blockquote', () => {
    expect(lex('> [!SHRUG]\n> Maybe.')[0].type).toBe('blockquote')
  })

  test('the alert tokenizer is marked safe for the streaming tail window', () => {
    // WHY: without the marker the incremental parser re-lexes the whole reply
    // on every streamed token as soon as a reply contains one alert.
    const tokenizer = alertMarkedExtension.extensions![0] as { tokenizer: object }
    expect(Reflect.get(tokenizer.tokenizer, Symbol.for('svelte-markdown.tailWindowSafe'))).toBe(true)
  })
})

describe('footnotes in a reply', () => {
  test('references and definitions become tokens, and the definitions leave the body', () => {
    const tokens = lex('A claim.[^1] Another.[^src]\n\n[^1]: First note.\n[^src]: See `docs/x.md`.\n')
    const refs = flatten(tokens).filter((token) => token.type === FOOTNOTE_REF_TOKEN)
    expect(refs.map((token) => (token as Token & { id: string }).id)).toEqual(['1', 'src'])
    const section = tokens.find((token) => token.type === FOOTNOTE_SECTION_TOKEN)
    expect(section).toMatchObject({
      footnotes: [
        { id: '1', text: 'First note.' },
        { id: 'src', text: 'See `docs/x.md`.' },
      ],
    })
    expect(tokens.some((token) => token.type === 'paragraph' && token.raw.includes('[^1]:'))).toBe(false)
  })
})

describe('extension choice', () => {
  test('each extension is added only when the reply uses its syntax, with a stable identity', () => {
    // WHY: a new array per call rebuilds the streaming parser on every token.
    const prose = assistantMarkdownExtensions('Plain.')
    expect(prose).toHaveLength(0)
    const alert = assistantMarkdownExtensions('> [!NOTE]\n> Hi')
    expect(alert).toEqual([alertMarkedExtension])
    expect(assistantMarkdownExtensions('> [!TIP]\n> Other')).toBe(alert)
    const footnote = assistantMarkdownExtensions('Claim.[^1]')
    expect(footnote).toEqual([footnoteMarkedExtension])
    expect(assistantMarkdownExtensions('> [!NOTE]\n> Hi.[^1]')).toEqual([alertMarkedExtension, footnoteMarkedExtension])
  })
})
