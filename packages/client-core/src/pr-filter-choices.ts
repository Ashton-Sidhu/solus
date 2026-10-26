/**
 * The label and author choices several repositories answered for a pull
 * request list's filters (`prFilterOptions`), as one list. Shared by the
 * workspace UI and the mobile app.
 */
import type { PrFilterChoice } from '@solus/contracts/providers'

/** First seen first, one choice per value whatever its case. */
export function mergeFilterChoices(lists: readonly (readonly PrFilterChoice[])[]): PrFilterChoice[] {
  const merged = new Map<string, PrFilterChoice>()
  for (const list of lists) {
    for (const choice of list) {
      const key = choice.value.toLowerCase()
      if (choice.value && !merged.has(key)) merged.set(key, choice)
    }
  }
  return [...merged.values()]
}
