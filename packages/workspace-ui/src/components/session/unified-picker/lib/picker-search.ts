import { searchTokens } from '@solus/contracts/search-query'

/**
 * How the picker reads a query, and the two choices the reader makes about it.
 *
 * The picker's pass over task titles and session names follows the word rule
 * the hosts' indexes follow (`SearchQuery`), so one query means
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

/** Flattened names, kept across keystrokes. Every keystroke reads every
 *  task's title again. A string key costs its hash once. */
const flattened = new Map<string, string>()
const FLATTENED_CAP = 8192

/** The words of `text`, folded and joined by one space: a name compared as a whole. */
export function flattenedLower(text: string): string {
  let value = flattened.get(text)
  if (value === undefined) {
    if (flattened.size >= FLATTENED_CAP) flattened.clear()
    value = searchTokens(text).map(token => token.text).join(' ')
    flattened.set(text, value)
  }
  return value
}
