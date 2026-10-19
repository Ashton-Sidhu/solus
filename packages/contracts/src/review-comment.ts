// Adapted from T3 Code reviewCommentSelection.ts (MIT, see apps/mobile/UPSTREAM.md).

/**
 * Line feedback and the source it is about, sent inside a user message as a
 * `<review_comment>` block. Mobile review selections store diff-row indexes in
 * `startIndex` and `endIndex`; desktop diff feedback stores file line numbers.
 * Only `rangeLabel` names file lines on every client.
 */
export interface ReviewInlineComment {
  readonly id: string
  readonly sectionId: string
  readonly sectionTitle: string
  readonly filePath: string
  readonly startIndex: number
  readonly endIndex: number
  readonly rangeLabel: string
  readonly text: string
  readonly diff: string
  readonly fenceLanguage?: string
}

export type ReviewCommentMessageSegment =
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'review-comment'; readonly comment: ReviewInlineComment }

export interface ReviewCommentLocation {
  path: string
  line?: number
}

// The closing tag must start a line. The serializer always writes it so, and a
// diff line always starts with a change marker, so a `</review_comment>` inside
// the reviewed source or the comment prose does not end the block.
const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)\n<\/review_comment>/g
const REVIEW_COMMENT_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g
const REVIEW_COMMENT_FENCE_PATTERN = /(`{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n\1/g

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** Keep line feedback and its selected source together across every client. */
export function formatReviewComment(comment: Omit<ReviewInlineComment, 'id'>): string {
  const longestBacktickRun = Math.max(0, ...Array.from(comment.diff.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  return [
    [
      '<review_comment',
      ` sectionId="${escapeAttribute(comment.sectionId)}"`,
      ` sectionTitle="${escapeAttribute(comment.sectionTitle)}"`,
      ` filePath="${escapeAttribute(comment.filePath)}"`,
      ` startIndex="${comment.startIndex}"`,
      ` endIndex="${comment.endIndex}"`,
      ` rangeLabel="${escapeAttribute(comment.rangeLabel)}"`,
      '>',
    ].join(''),
    comment.text.trim(),
    `${fence}${comment.fenceLanguage ?? 'diff'}`,
    comment.diff,
    fence,
    '</review_comment>',
  ].join('\n')
}

/** The file and first line a review card opens, read from the range label. */
export function reviewCommentLocation(
  comment: Pick<ReviewInlineComment, 'filePath' | 'rangeLabel'>,
): ReviewCommentLocation {
  const match = /^[+-]?(\d+)/.exec(comment.rangeLabel)
  return match ? { path: comment.filePath, line: Number(match[1]) } : { path: comment.filePath }
}

function readNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  return Number(value)
}

function parseReviewInlineComment(
  rawAttributes: string,
  rawBody: string,
  index: number,
): ReviewInlineComment | null {
  const attributes = new Map<string, string>()
  for (const match of rawAttributes.matchAll(REVIEW_COMMENT_ATTRIBUTE_PATTERN)) {
    attributes.set(match[1]!, unescapeAttribute(match[2] ?? ''))
  }
  const startIndex = readNonNegativeInteger(attributes.get('startIndex'))
  const endIndex = readNonNegativeInteger(attributes.get('endIndex'))
  const filePath = attributes.get('filePath')?.trim()
  const sectionId = attributes.get('sectionId')?.trim()
  if (!filePath || !sectionId || startIndex === null || endIndex === null) return null

  // The last fence is the selected source; earlier fences belong to the prose.
  const fence = Array.from(rawBody.matchAll(REVIEW_COMMENT_FENCE_PATTERN)).at(-1)
  return {
    id: `review-comment:${index}:${sectionId}:${filePath}:${startIndex}:${endIndex}`,
    sectionId,
    sectionTitle: attributes.get('sectionTitle')?.trim() || 'Review',
    filePath,
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
    rangeLabel: attributes.get('rangeLabel')?.trim() || 'line',
    text: rawBody.slice(0, fence?.index ?? rawBody.length).trim(),
    diff: fence?.[3] ?? '',
    fenceLanguage: fence?.[2]?.trim() || 'diff',
  }
}

/** Split a user message into prose and review cards. A malformed block stays prose. */
export function parseReviewCommentMessageSegments(value: string): ReadonlyArray<ReviewCommentMessageSegment> {
  const segments: ReviewCommentMessageSegment[] = []
  let cursor = 0
  let parsedCommentCount = 0
  for (const match of value.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', id: `review-comment-text:${cursor}`, text: value.slice(cursor, match.index) })
    }
    const comment = parseReviewInlineComment(match[1] ?? '', match[2] ?? '', parsedCommentCount)
    if (comment) {
      segments.push({ kind: 'review-comment', comment })
      parsedCommentCount += 1
    } else {
      segments.push({ kind: 'text', id: `review-comment-invalid:${match.index}`, text: match[0] })
    }
    cursor = match.index + match[0].length
  }
  if (cursor < value.length) {
    segments.push({ kind: 'text', id: `review-comment-text:${cursor}`, text: value.slice(cursor) })
  }
  return segments
}

export function parseReviewInlineComments(value: string): ReadonlyArray<ReviewInlineComment> {
  return parseReviewCommentMessageSegments(value).flatMap((segment) =>
    segment.kind === 'review-comment' ? [segment.comment] : [],
  )
}
