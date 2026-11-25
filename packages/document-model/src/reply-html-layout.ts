import { UNMEASURED_REPLY_HEIGHT, type ReplyHtmlLayout } from '@solus/contracts/session-history'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'
import { INLINE_REVIEW_FENCE, parseInlineReviewGuide, type InlineReviewGuide } from '@solus/contracts/inline-review-guide'
import { fenceRenderMode, isHtmlFence, parseFence } from './fences'
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
  | { readonly kind: 'guide'; readonly key: string; readonly guide: InlineReviewGuide }
  | { readonly kind: 'html'; readonly key: string; readonly html: string; readonly layout?: ReplyHtmlLayout }

const parser = unified().use(remarkParse)

// Most replies have no rendered fence; they skip the parse.
const RENDER_FENCE_OPENING = /^[ ]{0,3}(?:`{3,}|~{3,})[ \t]*(?:html|review-guide)\b/im

export function replySegments(markdown: string, layout?: readonly ReplyHtmlLayout[]): readonly ReplySegment[] {
  const whole: readonly ReplySegment[] = [{ kind: 'markdown', key: 'md:0', text: markdown }]
  if (!layout && !RENDER_FENCE_OPENING.test(markdown)) return whole
  const segments: ReplySegment[] = []
  let cursor = 0
  const fences = layout
    ? layout.map(frame => ({ start: frame.start, end: frame.end, body: markdown.slice(frame.bodyStart, frame.bodyEnd), guide: null, layout: frame }))
    : renderedFences(markdown)
  for (const { start, end, body, guide, layout: frame } of fences) {
    const before = markdown.slice(cursor, start)
    if (before.trim()) segments.push({ kind: 'markdown', key: `md:${cursor}`, text: before })
    segments.push(guide ? { kind: 'guide', key: `guide:${start}`, guide } : { kind: 'html', key: `html:${start}`, html: body, ...(frame && { layout: frame }) })
    cursor = end
  }
  if (segments.length === 0) return whole
  const after = markdown.slice(cursor)
  if (after.trim()) segments.push({ kind: 'markdown', key: `md:${cursor}`, text: after })
  return segments
}

function* renderedFences(markdown: string) {
  for (const node of parser.parse(markdown).children) {
    if (node.type !== 'code' || (node.lang !== INLINE_REVIEW_FENCE && !isHtmlFence(node.lang ?? undefined))) continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) continue
    // Null while the closing delimiter has not arrived.
    const fence = parseFence(markdown.slice(start, end))
    if (!fence) continue
    const guide = fence.info === INLINE_REVIEW_FENCE ? parseInlineReviewGuide(node.value) : null
    if (!guide && (!isHtmlFence(fence.info) || fenceRenderMode(fence.info, node.value) !== 'block')) continue
    yield { start, end, body: node.value, guide, layout: undefined }
  }
}

/** Offsets refer to the original Markdown. Unusual indented or normalized
 * bodies stay on the Markdown path, where the parser has their exact text. */
export function replyHtmlLayout(markdown: string, identify: (html: string) => string): ReplyHtmlLayout[] | undefined {
  if (!RENDER_FENCE_OPENING.test(markdown)) return
  const layouts: ReplyHtmlLayout[] = []
  for (const { start, end, body, guide } of renderedFences(markdown)) {
    if (guide) return
    const bodyStart = markdown.indexOf('\n', start) + 1
    const bodyEnd = bodyStart + body.length
    if (bodyEnd > end || markdown.slice(bodyStart, bodyEnd) !== body) return
    layouts.push({ start, end, bodyStart, bodyEnd, attachmentId: identify(body),
      title: resolveArtifactTitle(undefined, body), height: UNMEASURED_REPLY_HEIGHT })
  }
  return layouts.length ? layouts : undefined
}
