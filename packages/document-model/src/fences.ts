/**
 * How a fenced block reads, in a reply and in a document.
 *
 * A document keeps its markdown portable: an HTML render is a ```html fence
 * and a diagram is a ```mermaid fence, the same ones a reply renders, so the
 * file reads correctly in an editor that knows nothing about Solus. These
 * rules decide which fences are live blocks, so the editor, the host codec,
 * and the transcript make the same choice.
 */

/**
 * - **block** — a page to look at. It renders live in the sandbox frame.
 * - **snippet** — code to read. It stays a code block, with a Render action.
 *
 * The content decides, because an agent explaining a template bug pastes a
 * `<div>` to be read and rendering it would show an empty frame where the code
 * was. A fragment that carries its own styles or behaviour was written to be
 * looked at. The info string overrides the test in either direction, for the
 * cases it gets wrong: ```html render and ```html source.
 */
export type FenceRenderMode = 'block' | 'snippet'

/**
 * A Mermaid fence is a diagram to look at, so a settled fence renders on its
 * own. The one way out is the info string: ```mermaid source keeps it as code,
 * the same word an html fence uses. There is no content test, because Mermaid
 * text has no reading other than "draw this".
 */
export type MermaidRenderMode = 'diagram' | 'source'

/** The info string a block turns into when the reader asks to read it as code.
 *  `source` is what stops the next parse from rendering it again. */
export const HTML_SOURCE_INFO = 'html source'
export const MERMAID_SOURCE_INFO = 'mermaid source'

/** Markup that only renders faithfully inside the sandbox frame: it carries its
 *  own stylesheet, its own behaviour, a vector canvas, or a whole document. The
 *  frame is the one place `<style>` and `<script>` run.
 *
 *  Plain markup — a table, a details block, a div with inline styles — reads
 *  better in the host DOM under the app's prose styles, so it stays there. This
 *  is a fidelity test, not a safety one. */
const SANDBOX_MARKERS = /<(?:style|script|link|svg|canvas)[\s/>]|<!doctype|<html[\s>]/i

export function needsSandbox(html: string): boolean {
  return SANDBOX_MARKERS.test(html)
}

/** The words a fence's info string carries: the language, then any directive. */
function infoWords(info: string | undefined): string[] {
  return (info ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** The language a fence declares — the first word of its info string, so a
 *  directive after it never reaches a highlighter or a language label. */
export function fenceLanguage(info: string | undefined): string {
  return infoWords(info)[0] ?? ''
}

export function isHtmlFence(info: string | undefined): boolean {
  return fenceLanguage(info) === 'html'
}

export function fenceRenderMode(info: string | undefined, html: string): FenceRenderMode {
  const directives = infoWords(info).slice(1)
  if (directives.includes('render')) return 'block'
  if (directives.includes('source')) return 'snippet'
  return needsSandbox(html) ? 'block' : 'snippet'
}

export function isMermaidFence(info: string | undefined): boolean {
  return fenceLanguage(info) === 'mermaid'
}

export function mermaidRenderMode(info: string | undefined): MermaidRenderMode {
  return infoWords(info).slice(1).includes('source') ? 'source' : 'diagram'
}

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
  const explicit = infoWords(fence.info).slice(1).includes('render')
  return { raw: fence.raw, html: fence.body, explicit }
}

/** A complete ```mermaid fence at the head of `src` that should draw. Null for
 *  an open fence, another language, or one the author marked `source`. */
export function mermaidBlockFence(src: string): { raw: string; source: string } | null {
  const fence = parseFence(src)
  if (!fence || !isMermaidFence(fence.info)) return null
  if (mermaidRenderMode(fence.info) !== 'diagram') return null
  return { raw: fence.raw, source: fence.body }
}

/** A fence long enough that no backtick run in the body can close it early.
 *  Delimiters are normalized on save; the payload is kept exactly. */
function fenceAround(info: string, body: string): string {
  let longest = 0
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${info}\n${body}\n${fence}`
}

/** The markdown an HTML block node writes back. */
export function serializeHtmlBlock(html: string, explicit: boolean): string {
  return fenceAround(explicit ? 'html render' : 'html', html)
}

/** The markdown a Mermaid block node writes back. */
export function serializeMermaidBlock(source: string): string {
  return fenceAround('mermaid', source)
}
