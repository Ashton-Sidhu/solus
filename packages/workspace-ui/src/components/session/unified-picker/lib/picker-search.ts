/**
 * How the picker reads a query, and the two choices the reader makes about it.
 *
 * The full-text index the hosts search splits a query into words, requires
 * every word, and matches each at the start of a token. The picker's own pass
 * over task titles and session names follows the same rule, so one query means
 * one thing in both sections and the marks in a row agree with the index.
 */

/** What order a section lists its hits in. */
export type PickerSort = 'relevance' | 'recency'

/** What the query is matched against: everything the hosts indexed, or only
 *  the names of tasks and sessions. */
export type PickerSearchMode = 'full-text' | 'keywords'

export const PICKER_SORT_LABELS = {
  relevance: 'Relevance',
  recency: 'Recency',
} satisfies Record<PickerSort, string>

/** The header hint for a section under each order. */
export const PICKER_SORT_HINTS = {
  relevance: 'best match first',
  recency: 'newest first',
} satisfies Record<PickerSort, string>

/** The query's words, lower-cased. Empty for a blank query. */
export function queryWords(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

/** A token starts where the text starts or after a character that is neither a
 *  letter nor a digit — the same boundary the index's unicode61 tokenizer uses. */
function startsToken(text: string, at: number): boolean {
  return at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!)
}

/** Where `word` first starts a token of `text`, or -1. `text` is lower-cased
 *  by the caller once, not per word. */
export function wordStartIndex(lowerText: string, word: string, from = 0): number {
  let at = lowerText.indexOf(word, from)
  while (at >= 0 && !startsToken(lowerText, at)) at = lowerText.indexOf(word, at + 1)
  return at
}

/** True when every word starts a token of `text`. No words match everything. */
export function matchesEveryWord(text: string, words: readonly string[]): boolean {
  const lower = text.toLocaleLowerCase()
  return words.every((word) => wordStartIndex(lower, word) >= 0)
}

/** The position of the earliest word of the query in `text`, or -1. */
export function firstWordIndex(text: string, words: readonly string[]): number {
  const lower = text.toLocaleLowerCase()
  let earliest = -1
  for (const word of words) {
    const at = wordStartIndex(lower, word)
    if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at
  }
  return earliest
}
