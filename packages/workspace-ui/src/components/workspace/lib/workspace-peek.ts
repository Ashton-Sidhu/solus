import { parseDiagram } from '@solus/contracts/diagram-types'
import type { WorkspaceItem } from './workspace-items'

/** The transient hover card's contents and geometry. The card itself is markup;
 *  everything that decides *what* it says and *where* it sits lives here.
 *
 *  It reads a document it never renders: two sentences of prose and four lines
 *  of structure, extracted from the same markdown the editor would open. */

// ─── Body ───

/** Markdown reduced to the prose a reader would hear if they read it aloud —
 *  no fences, no bullets, no link URLs. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    // Headings are structure, and the outline below already carries them —
    // folding them into the prose makes the body open on the title.
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const BODY_MAX = 260

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The window around a query hit — enough left context that the match reads in
 *  a sentence rather than at the very edge of the card. */
function excerptAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 90)
  const head = start === 0 ? '' : '…'
  const tail = text.slice(start)
  const space = start === 0 ? 0 : tail.search(/\s/)
  const from = start + (space > 0 && space < 20 ? space + 1 : 0)
  return head + clip(text.slice(from), Math.max(BODY_MAX, length + 120))
}

function firstSentences(text: string, count: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/)
  return clip(sentences.slice(0, count).join(' '), BODY_MAX)
}

/**
 * The card's body: the first two sentences of the artifact, or — while a search
 * is running — the passage that actually matched, so the card answers the
 * question the query asked rather than restating the opening.
 *
 * Falls back to the ledger's own snippet until the content has loaded; a peek
 * never shows a spinner.
 */
export function peekBody(item: WorkspaceItem, content: string | null, query: string): string {
  const text = content ? plainText(content) : item.snippet
  if (!text) return ''
  const needle = query.trim().toLowerCase()
  if (needle) {
    const at = text.toLowerCase().indexOf(needle)
    if (at !== -1) return excerptAround(text, at, needle.length)
  }
  return firstSentences(text, 2)
}

// ─── Structure ───

export type OutlineLine = { n: string; text: string }
/** Four lines at most; a fifth and beyond collapse into `more`. */
export type PeekOutline = { lines: OutlineLine[]; more: number }

const OUTLINE_MAX = 4
const OUTLINE_LINE_MAX = 62

const EMPTY_OUTLINE: PeekOutline = { lines: [], more: 0 }

function inlineText(text: string): string {
  return clip(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/:+\s*$/, '')
      .trim(),
    OUTLINE_LINE_MAX,
  )
}

/**
 * The document's own spine: its top heading level, or — for a plan written as a
 * numbered list rather than sections — its steps.
 *
 * A lone top heading is the document's title, which the row above the card is
 * already showing, so the outline drops a level to find the structure under it.
 */
function markdownOutline(markdown: string): string[] {
  const body = markdown.replace(/```[\s\S]*?```/g, '')
  const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({
    level: m[1].length,
    text: inlineText(m[2]),
  }))
  if (headings.length) {
    const top = Math.min(...headings.map((h) => h.level))
    const deeper = headings.filter((h) => h.level > top)
    const spine = headings.filter((h) => h.level === top)
    if (spine.length > 1) return spine.map((h) => h.text)
    // A lone top heading is the document's own title, which the row above the
    // card is already showing. The structure is whatever sits under it — and if
    // nothing does, the document has none.
    if (deeper.length) {
      const next = Math.min(...deeper.map((h) => h.level))
      return deeper.filter((h) => h.level === next).map((h) => h.text)
    }
  }
  const ordered = [...body.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) => inlineText(m[1]))
  if (ordered.length) return ordered
  return [...body.matchAll(/^\s*[-*+]\s+(.+)$/gm)].map((m) => inlineText(m[1]))
}

/** A diagram's structure is its clusters — the named containers a reader would
 *  use to describe the drawing. Counts are not structure; they go on the meta
 *  line beside the kind. */
function diagramOutline(content: string): string[] {
  try {
    return parseDiagram(content)
      .nodes.filter((node) => node.group && node.label)
      .map((node) => inlineText(node.label))
  } catch {
    return []
  }
}

export function peekOutline(item: WorkspaceItem, content: string | null): PeekOutline {
  if (!content) return EMPTY_OUTLINE
  const all = item.type === 'diagram' ? diagramOutline(content) : markdownOutline(content)
  return {
    lines: all
      .slice(0, OUTLINE_MAX)
      .map((text, i) => ({ n: String(i + 1).padStart(2, '0'), text })),
    more: Math.max(0, all.length - OUTLINE_MAX),
  }
}

// ─── Geometry ───

/** Card width the spec draws, and the gutter it keeps inside the ledger. */
export const PEEK_WIDTH = 540
const PEEK_GUTTER = 24
/** The row's title column — the card hangs off the title it describes, not off
 *  the cursor. Glyph box (10px inset + 16px) plus the row's 11px gap. */
const TITLE_COLUMN = 37
/** Vertical overlap onto the row, so the card reads as an extension of it. */
const ROW_OVERLAP = 2

export type PeekBox = { width: number; left: number; top: number }

/**
 * Anchor the card to its row: left edge at the title column, top overlapping
 * the row by 2px, flipped above when it would cross the bottom of the ledger.
 * Everything is clamped inside the ledger — the list never scrolls to make room.
 */
export function peekBox(
  row: { top: number; bottom: number; left: number },
  ledger: { top: number; bottom: number; left: number; right: number },
  height: number,
): PeekBox {
  const width = Math.min(PEEK_WIDTH, ledger.right - ledger.left - PEEK_GUTTER * 2)
  const left = Math.min(
    Math.max(row.left + TITLE_COLUMN, ledger.left + PEEK_GUTTER),
    ledger.right - PEEK_GUTTER - width,
  )
  const below = row.bottom - ROW_OVERLAP
  const above = row.top + ROW_OVERLAP - height
  // Flip only when below overflows and above genuinely has more room — near the
  // top of a short ledger, flipping trades one clipped edge for a worse one.
  const overflows = below + height > ledger.bottom
  const top = overflows && above >= ledger.top ? above : below
  return { width, left, top }
}
