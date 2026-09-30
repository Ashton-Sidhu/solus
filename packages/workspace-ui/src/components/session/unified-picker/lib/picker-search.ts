import { holdsEveryWord, wordStartIndex } from '@solus/contracts/word-match'

export { queryWords, wordStartIndex } from '@solus/contracts/word-match'

/**
 * How the picker reads a query, and the two choices the reader makes about it.
 *
 * The picker's pass over task titles and session names follows the word rule
 * the hosts' indexes follow (`@solus/contracts/word-match`), so one query means
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

/** Lower-cased texts, kept across keystrokes. Every keystroke reads every
 *  task's title and body again, and lower-casing each of them was most of the
 *  time the list took to build. A string key costs its hash once. */
const lowered = new Map<string, string>()
const flattened = new Map<string, string>()
const LOWERED_CAP = 8192

function cached(cache: Map<string, string>, text: string, derive: (text: string) => string): string {
  let value = cache.get(text)
  if (value === undefined) {
    if (cache.size >= LOWERED_CAP) cache.clear()
    value = derive(text)
    cache.set(text, value)
  }
  return value
}

/** `text` lower-cased. Its positions are the positions of `text`. */
export function lowerCased(text: string): string {
  return cached(lowered, text, (source) => source.toLocaleLowerCase())
}

/** `text` lower-cased, whitespace collapsed and trimmed: a name compared as a whole. */
export function flattenedLower(text: string): string {
  return cached(flattened, text, (source) => lowerCased(source).replace(/\s+/g, ' ').trim())
}

/** True when every word starts a token of `text`. No words match everything. */
export function matchesEveryWord(text: string, words: readonly string[]): boolean {
  return holdsEveryWord(lowerCased(text), words)
}

/** The position of the earliest word of the query in `text`, or -1. */
export function firstWordIndex(text: string, words: readonly string[]): number {
  const lower = lowerCased(text)
  let earliest = -1
  for (const word of words) {
    const at = wordStartIndex(lower, word)
    if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at
  }
  return earliest
}
