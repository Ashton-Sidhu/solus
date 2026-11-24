/** A long settings list shows this many rows before "Show more". */
export const LIST_PAGE_SIZE = 8

/** One page of a long list: the rows shown, and how many wait behind "Show more". */
export interface ListPage<T> {
  rows: readonly T[]
  hiddenCount: number
}

/** The rows a list shows, and the words for the rest: all of them, or the first page with "Show N more". */
export function pageOf<T>(items: readonly T[], expanded: boolean): ListPage<T> {
  if (expanded || items.length <= LIST_PAGE_SIZE) return { rows: items, hiddenCount: 0 }
  return { rows: items.slice(0, LIST_PAGE_SIZE), hiddenCount: items.length - LIST_PAGE_SIZE }
}
