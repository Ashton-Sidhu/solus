import type { Attachment } from '../../../../shared/types'

/**
 * Substring, not the fuzzy scorer `Command` defaults to. That scorer is tuned
 * for command *names* — run over paragraph-length prompt bodies its subsequence
 * matching hits almost everything, so the list barely narrows as you type.
 */
export function matchesQuery(text: string, query: string): boolean {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return true
  return text.toLowerCase().includes(trimmed)
}

/** Collapse whitespace so a multi-line draft reads as one row. */
export function promptPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export interface PromptThumbnail {
  /** Set when the lead attachment is an image we can show inline. */
  dataUrl: string | null
  /** Drives the fallback icon when there's no image to show. */
  mimeType: string | null
  /** Attachments beyond the lead one, surfaced as a `+N` badge. */
  extra: number
}

/** What the 44x28 cell on a saved-prompt row shows. */
export function thumbnailFor(attachments: Attachment[]): PromptThumbnail | null {
  if (attachments.length === 0) return null
  const lead = attachments[0]
  return {
    dataUrl: lead.type === 'image' ? (lead.dataUrl ?? null) : null,
    mimeType: lead.mimeType ?? null,
    extra: attachments.length - 1,
  }
}
