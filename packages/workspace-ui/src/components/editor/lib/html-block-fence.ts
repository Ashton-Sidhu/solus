import { fenceRenderMode, isHtmlFence } from '../../conversation/lib/html-block'

/**
 * The fence a document's HTML block is written as.
 *
 * A document keeps its markdown portable: the block is a ```html fence, the
 * same one a reply renders, so the same file reads correctly in an editor that
 * knows nothing about Solus. The HTML payload must survive a save and reopen,
 * even when it contains Markdown examples. Fence delimiters are normalized on save.
 */

/** A complete fenced block at the head of `src`. Null when the fence is not
 *  closed: an open fence is left to the built-in tokenizer, which is what
 *  renders a half-written block as code rather than as a frame. */
export interface ParsedFence {
  raw: string
  info: string
  body: string
}

export function parseFence(src: string): ParsedFence | null {
  const opening = /^[ ]{0,3}(`{3,}|~{3,})([^\n]*)\n/.exec(src)
  if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) return null
  const closing = new RegExp(`^[ ]{0,3}${opening[1][0]}{${opening[1].length},}[ \t]*(?:\n|$)`, 'm')
  const rest = src.slice(opening[0].length)
  const match = closing.exec(rest)
  if (!match) return null
  const body = rest.slice(0, match.index).replace(/\n$/, '')
  return { raw: src.slice(0, opening[0].length + match.index + match[0].length), info: opening[2].trim(), body }
}

/** Whether a fence is a live HTML block rather than code to read, and whether
 *  the author said so in the info string. `explicit` is what survives the round
 *  trip: a block the reader rendered by hand writes itself back as
 *  ```html render, so the next parse makes the same choice. */
export function htmlBlockFence(src: string): { raw: string; html: string; explicit: boolean } | null {
  const fence = parseFence(src)
  if (!fence || !isHtmlFence(fence.info)) return null
  if (fenceRenderMode(fence.info, fence.body) !== 'block') return null
  const explicit = fence.info.toLowerCase().split(/\s+/).slice(1).includes('render')
  return { raw: fence.raw, html: fence.body, explicit }
}

/** The markdown an HTML block node writes back. */
export function serializeHtmlBlock(html: string, explicit: boolean): string {
  let longest = 0
  for (const match of html.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${explicit ? 'html render' : 'html'}\n${html}\n${fence}`
}

/** The info string a block turns into when the reader asks to read it as code.
 *  `source` is what stops the next parse from rendering it again. */
export const HTML_SOURCE_INFO = 'html source'
