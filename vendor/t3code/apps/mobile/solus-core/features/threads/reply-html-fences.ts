import { fenceRenderMode, isHtmlFence, parseFence } from '@solus/document-model/fences'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * An agent reply cut at its live HTML blocks: the ```html fences the shared
 * rules (`@solus/document-model/fences`) read as a page, which desktop and web
 * render in the sandbox frame. Enriched draws only Markdown, so each page is a
 * React slot between the Markdown parts.
 *
 * Only a closed fence at the top level of the reply is a page. A fence that is
 * still streaming stays code, so the frame is not built again for each token.
 * A fence inside a list or a quote stays code too: cutting there would break
 * the list or quote around it.
 */
export type ReplySegment =
  | { readonly kind: 'markdown'; readonly key: string; readonly text: string }
  | { readonly kind: 'html'; readonly key: string; readonly html: string }

const parser = unified().use(remarkParse)

// Most replies have no html fence; they skip the parse.
const HTML_FENCE_OPENING = /^[ ]{0,3}(?:`{3,}|~{3,})[ \t]*html\b/im

export function replySegments(markdown: string): readonly ReplySegment[] {
  const whole: readonly ReplySegment[] = [{ kind: 'markdown', key: 'md:0', text: markdown }]
  if (!HTML_FENCE_OPENING.test(markdown)) return whole
  const segments: ReplySegment[] = []
  let cursor = 0
  for (const node of parser.parse(markdown).children) {
    if (node.type !== 'code' || !isHtmlFence(node.lang ?? undefined)) continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) continue
    // Null while the closing delimiter has not arrived.
    const fence = parseFence(markdown.slice(start, end))
    if (!fence || fenceRenderMode(fence.info, node.value) !== 'block') continue
    const before = markdown.slice(cursor, start)
    if (before.trim()) segments.push({ kind: 'markdown', key: `md:${cursor}`, text: before })
    segments.push({ kind: 'html', key: `html:${start}`, html: node.value })
    cursor = end
  }
  if (segments.length === 0) return whole
  const after = markdown.slice(cursor)
  if (after.trim()) segments.push({ kind: 'markdown', key: `md:${cursor}`, text: after })
  return segments
}
