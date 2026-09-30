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
  // Line by line rather than `split`: a thought can run to many kilobytes and
  // only its first readable line is wanted.
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\n', start)
    const line = stripMarkdown(text.slice(start, end === -1 ? text.length : end))
    if (line) return line.length > MAX_PREVIEW_CHARS ? `${line.slice(0, MAX_PREVIEW_CHARS - 1)}…` : line
    if (end === -1) break
    start = end + 1
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

/** The first readable line across a run of thoughts, read in order. */
export function firstThoughtPreview(thoughts: string[]): string {
  for (const thought of thoughts) {
    const preview = thoughtPreview(thought)
    if (preview) return preview
  }
  return ''
}

/** The latest thought a tool group carries — the one closest to what the
 *  agent did last. */
export function latestThoughtPreview(tools: Message[]): string {
  for (let i = tools.length - 1; i >= 0; i--) {
    const thoughts = tools[i].thoughts ?? []
    for (let j = thoughts.length - 1; j >= 0; j--) {
      const preview = thoughtPreview(thoughts[j])
      if (preview) return preview
    }
  }
  return ''
}
