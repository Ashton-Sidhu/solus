/**
 * The one search rule of Solus list menus: a row matches when its label holds
 * every word of the search, in any order. A menu filters its own rows with it
 * and turns off the command menu's own filter (`shouldFilter={false}`), which
 * reorders rows by moving their DOM nodes behind Svelte's keyed lists.
 */

/** The lowercase words of a search. */
export function searchWords(search: string): string[] {
  return search.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Whether a row's label holds every word of the search. */
export function matchesSearch(label: string, search: string): boolean {
  const text = label.toLowerCase()
  return searchWords(search).every((word) => text.includes(word))
}
