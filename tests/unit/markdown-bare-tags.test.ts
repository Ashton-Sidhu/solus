import { describe, expect, test } from 'bun:test'
import { Marked, type Token } from 'marked'
// The library's own pipeline: marked's lexer, then the html pairing pass whose
// output the Parser renders. A lone html token with no `tag` renders as nothing.
import { lexAndClean } from '../../node_modules/@humanspeak/svelte-markdown/dist/utils/parse-and-cache.js'
import { IncrementalParser } from '../../node_modules/@humanspeak/svelte-markdown/dist/utils/incremental-parser.js'
import { assistantMarkdownExtensions } from '../../packages/workspace-ui/src/components/conversation/lib/assistant-markdown'

function optionsFor(source: string) {
  return { ...new Marked(...assistantMarkdownExtensions(source)).defaults }
}

function tokensOf(source: string): Token[] {
  return lexAndClean(source, optionsFor(source), false)
}

/** Every token, depth first, through list items too. */
function flatten(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => {
    const children = 'items' in token ? (token.items as Token[]) : 'tokens' in token ? (token.tokens as Token[]) : []
    return [token, ...flatten(children ?? [])]
  })
}

/** The text the Parser shows: text tokens render their source as text. */
function shownText(source: string): string {
  return flatten(tokensOf(source))
    .filter((token) => (token.type === 'text' || token.type === 'codespan' || token.type === 'code') && !('tokens' in token && token.tokens))
    .map((token) => (token.type === 'text' ? token.raw : (token as Token & { text: string }).text))
    .join('')
}

/** Html tokens the Parser would render as nothing: no element, no children. */
function droppedHtml(source: string): string[] {
  return flatten(tokensOf(source))
    .filter((token) => token.type === 'html' && !('tag' in token && token.tag))
    .map((token) => token.raw)
}

describe('bare tags in assistant markdown', () => {
  test('an unpaired placeholder shows as the text the reply wrote', () => {
    // WHY: the library pairs html tokens and renders a lone tag as nothing, so
    // a reply about `<A>` and `<B>` read "Use  and  as placeholders."
    const source = 'Use <A> and <B> as placeholders.'
    expect(droppedHtml(source)).toEqual([])
    expect(shownText(source)).toBe(source)

    expect(shownText('**"From <A>"** is the header.')).toBe('"From <A>" is the header.')
    expect(shownText('Ends at </B>.')).toBe('Ends at </B>.')
  })

  test('a placeholder alone on its line is kept too', () => {
    // WHY: marked reads a tag alone on a line as an html block, as in `- <A>`.
    expect(droppedHtml('- <A>\n- <B>\n')).toEqual([])
    expect(shownText('- <A>\n- <B>\n')).toBe('<A><B>')
  })

  test('paired markup still renders as elements', () => {
    const tokens = flatten(
      tokensOf('Press <kbd>K</kbd>, see <a href="https://example.com">x</a>.\n\n<details>\n<summary>More</summary>\n\nBody\n\n</details>\n'),
    )
    const tags = tokens.filter((token) => token.type === 'html').map((token) => (token as Token & { tag?: string }).tag)
    expect(tags).toEqual(['kbd', 'a', 'details', 'summary'])
    expect(tokens.some((token) => token.type === 'text' && token.raw.includes('<'))).toBe(false)
  })

  test('void and raw-text elements are not placeholders', () => {
    expect(shownText('One<br>two')).toBe('Onetwo')
    expect(tokensOf('<style>\nb{}\n</style>\n')[0]?.type).not.toBe('paragraph')
  })

  test('a placeholder in code is shown once, unescaped', () => {
    expect(shownText('Inline `<A>` here.\n\n```\nfn <B>()\n```\n')).toBe('Inline <A> here.fn <B>()')
  })

  test('the streaming parser keeps the placeholder too', () => {
    // WHY: the transcript renders through the incremental parser. A fix only in
    // the one-shot path would drop the placeholder while the reply arrives.
    const full = 'Use <A> and <B> as placeholders.\n\nNext.'
    const parser = new IncrementalParser(optionsFor(full))
    parser.update('Use <A> and')
    const tokens = flatten(parser.update(full).tokens)
    expect(tokens.filter((token) => token.type === 'html')).toEqual([])
    expect((tokens[0] as Token).raw).toBe('Use <A> and <B> as placeholders.')
  })
})
