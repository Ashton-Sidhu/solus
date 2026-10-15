import { Marked, type MarkedExtension, type Token } from 'marked'
import { FOOTNOTE_REF_TOKEN, FOOTNOTE_SECTION_TOKEN } from './markdown-extensions'
import { RAW_HTML_TOKEN } from './raw-html'

/** Extension tokens that need the whole reply, so the reply is not split. */
const WHOLE_REPLY_TOKENS = new Set([RAW_HTML_TOKEN, FOOTNOTE_REF_TOKEN, FOOTNOTE_SECTION_TOKEN])

/** Token types the transcript's markdown component renders as bare tags with
 *  no component of ours: their HTML from marked is the same markup. */
const PLAIN_TYPES = new Set(['paragraph', 'text', 'strong', 'em', 'del', 'br', 'space', 'hr', 'list', 'list_item', 'blockquote', 'escape'])

/** A run of a finished reply: HTML for plain blocks, tokens for the rest. */
export type SettledBlock = { html: string } | { tokens: Token[] }

function childrenOf(token: Token): Token[] {
  if (token.type === 'list') return token.items
  return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : []
}

/** A plain block is all plain tags down to its text. A task item draws a
 *  checkbox, and a loose list puts its items in paragraphs only in marked, so
 *  both stay with the component. */
function isPlain(token: Token): boolean {
  if (!PLAIN_TYPES.has(token.type)) return false
  if (token.type === 'list' && token.loose) return false
  if (token.type === 'list_item' && token.task) return false
  return childrenOf(token).every(isPlain)
}

const markedFor = new WeakMap<MarkedExtension[], Marked>()

/**
 * Split a finished reply into plain runs, written as HTML once, and the blocks
 * our renderers draw (code, links, images, tables, headings), passed on as
 * tokens so nothing parses twice. The markdown component built one component
 * per token: most of a reply's mount (docs/plans/session-open-performance.md).
 * A reply with raw HTML or footnotes is not split: both need the whole reply.
 */
export function settledMarkdownBlocks(source: string, extensions: MarkedExtension[]): SettledBlock[] | null {
  if (extensions.some((extension) => extension.extensions?.some((tokenizer) => WHOLE_REPLY_TOKENS.has(tokenizer.name)))) return null
  let marked = markedFor.get(extensions)
  if (!marked) {
    // The component's own defaults: GitHub flavour, no hard line breaks.
    marked = new Marked({ gfm: true, breaks: false, pedantic: false }, ...extensions)
    markedFor.set(extensions, marked)
  }
  const blocks: SettledBlock[] = []
  let plain: Token[] = []
  const flushPlain = () => {
    if (!plain.length) return
    blocks.push({ html: marked.parser(plain) })
    plain = []
  }
  for (const token of marked.lexer(source)) {
    const last = blocks.at(-1)
    // A blank line after our renderers' block joins it, not a run of its own.
    if (token.type === 'space' && !plain.length && last && 'tokens' in last) {
      last.tokens.push(token)
      continue
    }
    if (isPlain(token)) {
      plain.push(token)
      continue
    }
    flushPlain()
    const previous = blocks.at(-1)
    if (previous && 'tokens' in previous) previous.tokens.push(token)
    else blocks.push({ tokens: [token] })
  }
  flushPlain()
  return blocks
}
