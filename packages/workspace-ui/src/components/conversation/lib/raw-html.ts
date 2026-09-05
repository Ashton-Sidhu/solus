import type { MarkedExtension } from 'marked'
import { needsSandbox } from '../../artifact/lib/artifact-view'

/**
 * Raw HTML written straight into a reply, with no fence around it.
 *
 * The markdown library renders block-level tags in the host DOM through its own
 * tag map, which is the right answer for a table or a details block: they
 * inherit the app's prose styles. It has no map entry for `<style>` or
 * `<script>`, so markup that brings its own look arrives stripped of it — the
 * stylesheet's text prints as a paragraph and the layout it described is gone.
 *
 * A contiguous run of such markup therefore goes to the sandbox frame instead,
 * under the same `needsSandbox` test a fenced block uses. The run is scanned as
 * one unit on purpose: a `<style>` element and the markup it styles are two
 * top-level elements and one render.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose content is text, not markup: a `<` inside them opens nothing. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

const TAG_NAME_RE = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/

/** Index just past the `>` closing the tag that starts at `from`, or -1. A
 *  quoted attribute value may hold a `>`, so this cannot be an indexOf. */
function tagEnd(src: string, from: number): number {
  let quote = ''
  for (let i = from + 1; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i + 1
  }
  return -1
}

function isSelfClosing(src: string, from: number, to: number): boolean {
  return src.slice(from, to).trimEnd().endsWith('/>')
}

/** Index just past the raw-text element opened at `open`, or -1. */
function rawTextEnd(src: string, tag: string, open: number): number {
  const closing = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, 'ig')
  closing.lastIndex = open
  const match = closing.exec(src)
  return match ? tagEnd(src, match.index) : -1
}

/** Index just past the `</tag>` that balances the element opened at `open`, or
 *  -1 when it never arrives. Same-name nesting is counted; a raw-text element
 *  met on the way is skipped whole, because a `</div>` inside a script is
 *  text and ending the run there would cut the render in half. */
function balancedEnd(src: string, tag: string, open: number): number {
  let depth = 1
  let i = open
  while (depth > 0) {
    const next = src.indexOf('<', i)
    if (next === -1) return -1
    if (src.startsWith('<!--', next)) {
      const close = src.indexOf('-->', next)
      if (close === -1) return -1
      i = close + 3
      continue
    }
    const end = tagEnd(src, next)
    if (end === -1) return -1
    const found = TAG_NAME_RE.exec(src.slice(next, next + 64))?.[1]?.toLowerCase()
    const closing = src[next + 1] === '/'
    if (found === tag) depth += closing ? -1 : isSelfClosing(src, next, end) ? 0 : 1
    else if (found && !closing && RAW_TEXT_TAGS.has(found)) {
      i = rawTextEnd(src, found, end)
      if (i === -1) return -1
      continue
    }
    i = end
  }
  return i
}

/** Index just past the element starting at `from`, or -1 when it is not an
 *  element or is never closed. An unclosed element is left to the markdown
 *  library: while a reply streams, every element is unclosed for a while. */
function elementEnd(src: string, from: number): number {
  if (src[from] !== '<') return -1
  if (src.startsWith('<!--', from)) {
    const close = src.indexOf('-->', from)
    return close === -1 ? -1 : close + 3
  }
  // `<!doctype html>` and friends close at the first unquoted `>`.
  if (src[from + 1] === '!') return tagEnd(src, from)

  const name = TAG_NAME_RE.exec(src.slice(from, from + 64))?.[1]
  if (!name || src[from + 1] === '/') return -1
  const open = tagEnd(src, from)
  if (open === -1) return -1

  const tag = name.toLowerCase()
  if (VOID_TAGS.has(tag) || isSelfClosing(src, from, open)) return open
  if (RAW_TEXT_TAGS.has(tag)) return rawTextEnd(src, tag, open)
  return balancedEnd(src, tag, open)
}

export interface RawHtmlRun {
  /** The source consumed, including the trailing newline the block ends on. */
  raw: string
  /** The markup to run in the frame. */
  html: string
}

/** The run of raw block HTML at the head of `src` that has to render in the
 *  frame, or null — in which case the markdown library's own tag map keeps it. */
export function rawHtmlRun(src: string): RawHtmlRun | null {
  const indent = /^[ \t]{0,3}(?=<)/.exec(src)
  if (!indent) return null

  let cursor = indent[0].length
  let end = -1
  for (;;) {
    const next = elementEnd(src, cursor)
    if (next === -1) break
    end = next
    // Only whitespace may separate one top-level element from the next, so a
    // stylesheet and the markup it styles stay in one render.
    const gap = /^\s*/.exec(src.slice(next))![0]
    if (src[next + gap.length] !== '<') break
    cursor = next + gap.length
  }
  if (end === -1) return null

  const html = src.slice(0, end)
  if (!needsSandbox(html)) return null
  const trailing = /^[ \t]*\n?/.exec(src.slice(end))![0]
  return { raw: src.slice(0, end + trailing.length), html: html.trim() }
}

export const RAW_HTML_TOKEN = 'solusRawHtml'

/** Claims such a run before marked's own block-html rule sees it. Block-level
 *  extension tokenizers run first, which is the only reason this works. */
export const rawHtmlMarkedExtension: MarkedExtension = {
  extensions: [
    {
      name: RAW_HTML_TOKEN,
      level: 'block',
      start(src: string) {
        const index = src.search(/(?:^|\n)[ \t]{0,3}</)
        return index === -1 ? undefined : index
      },
      tokenizer(src: string) {
        const run = rawHtmlRun(src)
        if (!run) return undefined
        return { type: RAW_HTML_TOKEN, raw: run.raw, html: run.html }
      },
    },
  ],
}
