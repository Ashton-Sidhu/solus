import type { Editor } from '@tiptap/core'
import { textBetweenIdxToPos } from '../../plan/lib/comments'

/** A text match in Solus is not proof of a live Google anchor. Never guess between duplicates. */
export function googleQuoteRange(doc: Editor['state']['doc'], quote: string): { from: number; to: number } | null {
  if (!quote) return null
  const text = doc.textBetween(0, doc.content.size, ' ')
  const index = text.indexOf(quote)
  if (index < 0 || text.indexOf(quote, index + 1) >= 0) return null
  const from = textBetweenIdxToPos(doc, index)
  const to = textBetweenIdxToPos(doc, index + quote.length)
  return from >= 0 && to > from ? { from, to } : null
}
