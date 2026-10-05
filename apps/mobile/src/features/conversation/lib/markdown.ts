/**
 * The markdown an agent writes, as blocks and inline spans for native Text.
 * It covers what transcripts use most: fenced code, headings, lists, quotes,
 * paragraphs, inline code, bold, italic, and links. Anything else stays text.
 * Parsed per row, so a streamed token re-parses one message only.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; url: string }

export type Block =
  | { kind: 'code'; language: string; text: string }
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }

const FENCE = /^(\s*)(```|~~~)\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      const code = readFence(lines, index + 1, fence[2] ?? '```')
      blocks.push({ kind: 'code', language: fence[3] ?? '', text: code.text })
      index = code.end
    } else if (!line.trim()) {
      flushParagraph()
    } else if (!addLineBlock(blocks, line, flushParagraph)) {
      paragraph.push(line)
    }
  }
  flushParagraph()
  return blocks
}

/** A fence's body and the index of its closing line. */
interface FencedCode {
  text: string
  end: number
}

/** A fence's body up to its closing marker; an unclosed fence (still
 *  streaming) runs to the end. */
function readFence(lines: string[], start: number, marker: string): FencedCode {
  let end = start
  while (end < lines.length && !(lines[end] ?? '').trim().startsWith(marker)) end += 1
  return { text: lines.slice(start, end).join('\n'), end }
}

/** A heading, list item, or quote line; false for paragraph text. List items
 *  join the list before them when it is the same kind. */
function addLineBlock(blocks: Block[], line: string, flushParagraph: () => void): boolean {
  const heading = HEADING.exec(line)
  if (heading) {
    flushParagraph()
    blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, inlines: parseInline(heading[2] ?? '') })
    return true
  }
  const bullet = BULLET.exec(line)
  const numbered = bullet ? null : NUMBERED.exec(line)
  const item = bullet ?? numbered
  if (item) {
    flushParagraph()
    const ordered = !!numbered
    const previous = blocks[blocks.length - 1]
    const inlines = parseInline(item[1] ?? '')
    if (previous?.kind === 'list' && previous.ordered === ordered) previous.items.push(inlines)
    else blocks.push({ kind: 'list', ordered, items: [inlines] })
    return true
  }
  const quote = QUOTE.exec(line)
  if (quote) {
    flushParagraph()
    blocks.push({ kind: 'quote', inlines: parseInline(quote[1] ?? '') })
    return true
  }
  return false
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g

export function parseInline(text: string): Inline[] {
  const spans: Inline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) spans.push({ kind: 'text', text: text.slice(last, at) })
    const token = match[0]
    if (match[1]) spans.push({ kind: 'code', text: token.slice(1, -1) })
    else if (match[2]) spans.push({ kind: 'strong', text: token.slice(2, -2) })
    else if (match[3]) spans.push({ kind: 'em', text: token.slice(1, -1) })
    else {
      const close = token.indexOf('](')
      spans.push({ kind: 'link', text: token.slice(1, close), url: token.slice(close + 2, -1) })
    }
    last = at + token.length
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) })
  return spans
}

/** Links a tap may open on this device. `plan://` and file paths are host-side. */
export function isOpenableUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url)
}
