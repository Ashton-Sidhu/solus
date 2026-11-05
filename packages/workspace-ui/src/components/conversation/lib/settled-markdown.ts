import { Marked, Renderer, type MarkedExtension, type RendererObject, type Token } from 'marked'
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

/** Finished replies, most recently used last, keyed by extension set and
 *  text. A conversation that mounts again (ConversationPool unmounts older
 *  ones) does not lex a long reply again: a 50 KB reply costs hundreds of
 *  milliseconds. About 10 MB of text; a reply over a quarter of that is not
 *  kept. Only finished replies come here: a streaming reply never does. */
const CACHE_MAX_CHARS = 500_000
const ENTRY_MAX_CHARS = CACHE_MAX_CHARS / 4
const settledCache = new Map<string, SettledBlock[] | null>()
let cachedChars = 0
const extensionSetIds = new WeakMap<MarkedExtension[], number>()
let nextExtensionSetId = 0

function cacheKey(source: string, extensions: MarkedExtension[]): string {
  let id = extensionSetIds.get(extensions)
  if (id === undefined) {
    id = nextExtensionSetId++
    extensionSetIds.set(extensions, id)
  }
  return `${id}:${source}`
}

/** Lists and quotes get `dir="auto"`, as `MarkdownList` and
 *  `MarkdownBlockquote` give them in the markdown component. A Hebrew or
 *  Arabic list then has its markers on the right. */
const messageRenderer: RendererObject = {
  list(token) {
    return Renderer.prototype.list.call(this, token).replace(/^<(?:ul|ol)/, '$& dir="auto"')
  },
  blockquote(token) {
    return Renderer.prototype.blockquote.call(this, token).replace(/^<blockquote/, '$& dir="auto"')
  },
}

/**
 * Split a finished reply into plain runs, written as HTML once, and the blocks
 * our renderers draw (code, links, images, tables, headings), passed on as
 * tokens so nothing parses twice. The markdown component built one component
 * per token: most of a reply's mount (docs/plans/session-open-performance.md).
 * A reply with raw HTML or footnotes is not split: both need the whole reply.
 */
export function settledMarkdownBlocks(source: string, extensions: MarkedExtension[]): SettledBlock[] | null {
  if (source.length > ENTRY_MAX_CHARS) return lexSettledBlocks(source, extensions)
  const key = cacheKey(source, extensions)
  const hit = settledCache.get(key)
  if (hit !== undefined) {
    settledCache.delete(key)
    settledCache.set(key, hit)
    return hit
  }
  const blocks = lexSettledBlocks(source, extensions)
  settledCache.set(key, blocks)
  cachedChars += source.length
  for (const [oldest] of settledCache) {
    if (cachedChars <= CACHE_MAX_CHARS) break
    settledCache.delete(oldest)
    cachedChars -= oldest.length - oldest.indexOf(':') - 1
  }
  return blocks
}

function lexSettledBlocks(source: string, extensions: MarkedExtension[]): SettledBlock[] | null {
  if (extensions.some((extension) => extension.extensions?.some((tokenizer) => WHOLE_REPLY_TOKENS.has(tokenizer.name)))) return null
  let marked = markedFor.get(extensions)
  if (!marked) {
    // The component's own defaults: GitHub flavour, no hard line breaks.
    marked = new Marked({ gfm: true, breaks: false, pedantic: false, renderer: messageRenderer }, ...extensions)
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
