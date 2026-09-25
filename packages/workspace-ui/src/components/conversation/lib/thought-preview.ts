import type { Message } from '@solus/contracts/types'

/** A bound on what a tool message keeps: the row truncates with CSS long
 *  before this, so the rest of a runaway first line is only memory. */
const MAX_PREVIEW_CHARS = 240

/**
 * The first line of a thought, as plain text for the activity row. Both
 * providers write reasoning as markdown — Claude's summarised thinking and
 * Codex's reasoning summaries usually lead with a `**bold**` title — so the
 * markup is stripped rather than shown as asterisks. Empty when the thought has
 * no readable text (redacted or encrypted reasoning), so callers fall back to
 * the plain label.
 */
export function thoughtPreview(text: string | undefined): string {
  if (!text) return ''
  for (const rawLine of text.split('\n')) {
    const line = stripMarkdown(rawLine)
    if (line) return line.length > MAX_PREVIEW_CHARS ? `${line.slice(0, MAX_PREVIEW_CHARS - 1)}…` : line
  }
  return ''
}

function stripMarkdown(line: string): string {
  // A code fence or a horizontal rule is structure, not a first line.
  if (/^\s*(?:```|~~~|(?:[-*_]\s*){3,}$)/.test(line)) return ''
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)*/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The latest thought a tool group carries — the one closest to what the
 *  agent did last. */
export function latestThoughtPreview(tools: Message[]): string {
  for (let i = tools.length - 1; i >= 0; i--) {
    const preview = tools[i].thinkingPreview
    if (preview) return preview
  }
  return ''
}
