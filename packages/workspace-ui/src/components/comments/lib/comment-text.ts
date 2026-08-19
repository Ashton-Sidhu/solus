/**
 * What a comment is allowed to say.
 *
 * Comment prose is Inter, never the document's serif — a thread is chrome that
 * happens to hold sentences. It gets mentions, links, inline code, one-line
 * code quotes, bold and italic, and nothing else: a comment that needs a
 * heading, a table or an image wants to be a document.
 *
 * So this is an allowlist tokenizer rather than a markdown renderer. Anything
 * outside the set stays literal text, which means a pasted `# heading` reads
 * as the characters the author typed instead of silently becoming structure.
 */

export type Segment =
  | { kind: 'plain'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'mention'; text: string }
  | { kind: 'link'; text: string; href: string }

export type Block =
  | { kind: 'text'; segments: Segment[] }
  /** A one-line code quote — a hairline and mono type, never a fill. */
  | { kind: 'quote'; text: string }

/**
 * Ordered by precedence: inline code first, so a URL or an asterisk inside
 * backticks stays literal.
 *
 * `image` is a rule for something the set does *not* allow: it matches the
 * whole `![alt](url)` and hands it back as plain text. Without it the link
 * rules would find the URL inside and quietly render half an image as a link.
 */
const INLINE = [
  { kind: 'code', re: /`([^`\n]+)`/ },
  { kind: 'image', re: /!\[[^\]\n]*\]\([^\s)]*\)/ },
  { kind: 'mdLink', re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/ },
  { kind: 'bareLink', re: /(https?:\/\/[^\s<>()]+)/ },
  { kind: 'bold', re: /\*\*([^*\n]+)\*\*/ },
  { kind: 'italic', re: /(?:\*([^*\n]+)\*|_([^_\n]+)_)/ },
  { kind: 'mention', re: /@([A-Za-z0-9][A-Za-z0-9._-]*)/ },
] as const

function nextMatch(text: string): { index: number; length: number; segment: Segment } | null {
  let best: { index: number; length: number; segment: Segment } | null = null
  for (const { kind, re } of INLINE) {
    const match = re.exec(text)
    if (!match) continue
    // A later rule only wins if it starts strictly earlier — precedence is the
    // tie-break, which is what keeps `**bold**` out of the italic rule.
    if (best && match.index >= best.index) continue
    const [raw, first, second] = match
    const segment: Segment =
      kind === 'code'
        ? { kind: 'code', text: first }
        : kind === 'image'
          ? { kind: 'plain', text: raw }
          : kind === 'mdLink'
            ? { kind: 'link', text: first, href: second }
            : kind === 'bareLink'
              ? { kind: 'link', text: first, href: first }
              : kind === 'bold'
                ? { kind: 'bold', text: first }
                : kind === 'italic'
                  ? { kind: 'italic', text: first ?? second }
                  : { kind: 'mention', text: raw }
    best = { index: match.index, length: raw.length, segment }
  }
  return best
}

export function parseInline(text: string): Segment[] {
  const segments: Segment[] = []
  let rest = text
  while (rest) {
    const match = nextMatch(rest)
    if (!match) break
    if (match.index > 0) segments.push({ kind: 'plain', text: rest.slice(0, match.index) })
    segments.push(match.segment)
    rest = rest.slice(match.index + match.length)
  }
  if (rest) segments.push({ kind: 'plain', text: rest })
  return segments
}

/**
 * A leading `>` makes a one-line code quote. A second level of `>` is not a
 * nested quote — it is literal text, because a thread has no room for one.
 */
export function parseCommentText(text: string): Block[] {
  const blocks: Block[] = []
  for (const line of text.split('\n')) {
    const quote = /^>\s?(?!>)(.*)$/.exec(line)
    if (quote) {
      blocks.push({ kind: 'quote', text: quote[1] })
      continue
    }
    const previous = blocks[blocks.length - 1]
    if (previous?.kind === 'text') {
      previous.segments.push({ kind: 'plain', text: '\n' }, ...parseInline(line))
      continue
    }
    blocks.push({ kind: 'text', segments: parseInline(line) })
  }
  return blocks
}

/** Body preview for the 4-line clamp's "more" affordance and for hover cards. */
export function plainText(text: string): string {
  return parseCommentText(text)
    .map((block) => (block.kind === 'quote' ? block.text : block.segments.map((s) => s.text).join('')))
    .join(' ')
    .trim()
}
