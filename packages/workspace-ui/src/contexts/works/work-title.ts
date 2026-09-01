/** Titles a work is born with: `createBlankWork` in the renderer, and the
 *  create_work tool's fallback on the server. While a work still carries one,
 *  nobody has named it, so the first heading the user types can claim it. */
const PLACEHOLDER_TITLES = new Set([
  '',
  'untitled',
  'untitled document',
  'untitled diagram',
  'untitled slides',
])

/** A title long enough to say what the document is, short enough for a tab. */
const MAX_TITLE_LENGTH = 120

export function isPlaceholderWorkTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title.trim().toLowerCase())
}

/** The text of the document's first level-1 heading, or null when it has none
 *  yet. Headings inside a fenced code block are content, not the document's
 *  name, so they are skipped. */
export function firstHeadingTitle(markdown: string): string | null {
  let insideFence = false
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      insideFence = !insideFence
      continue
    }
    if (insideFence) continue
    const heading = /^#\s+(.*)$/.exec(trimmed)
    if (!heading) continue
    // Drop an ATX closing sequence ("# Title #"), which is punctuation.
    const text = heading[1].replace(/\s+#*$/, '').trim()
    if (text) return text.slice(0, MAX_TITLE_LENGTH)
  }
  return null
}
