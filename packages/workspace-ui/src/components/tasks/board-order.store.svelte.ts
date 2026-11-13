import { SvelteMap } from 'svelte/reactivity'
import { z } from 'zod'
import type { BoardRanks } from './lib/board-order'

const STORAGE_KEY = 'solus.tasks.board-ranks'

/**
 * Where the manually-placed board cards live.
 *
 * Order is a per-viewer reading of a shared list — "this is what *I* am doing
 * next" — so it is kept client-side, rather than written back to the provider.
 * It is keyed by board view, because the columns of one view are
 * not the columns of another. That also lets a GitHub issue be dragged beside
 * a Jira issue: neither provider has to own a field for it.
 *
 * The trade is that the order does not follow you to another machine. If it
 * should, this class is the seam: a rank per task is already the shape a
 * `board_rank` column wants, and only `setColumnOrder` would change — a
 * fractional key between the drop's two neighbours, so one drag writes one row
 * instead of renumbering the column.
 */
export class BoardOrderStore {
  #byBoard = new SvelteMap<string, BoardRanks>()

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const storedRanks = z.record(z.string(), z.record(z.string(), z.number())).parse(JSON.parse(raw))
        for (const [boardKey, ranks] of Object.entries(storedRanks)) {
          this.#byBoard.set(boardKey, ranks)
        }
      }
    } catch {
      // A malformed or unavailable store is not worth failing the board over —
      // the columns simply fall back to the page's sort.
    }
  }

  /** A board's card ranks (empty until something is dragged). */
  ranksFor(boardKey: string | null): BoardRanks {
    if (!boardKey) return {}
    return this.#byBoard.get(boardKey) ?? {}
  }

  /**
   * Record a column's cards in the order they now read, top to bottom.
   *
   * Callers pass the column exactly as it will render, so the rank *is* the
   * array index — there is no position to compute. Ranks only ever compare
   * within a column, so numbering columns independently costs nothing.
   */
  setColumnOrder(boardKey: string | null, orderedIds: string[]): void {
    if (!boardKey) return
    const next = { ...this.ranksFor(boardKey) }
    orderedIds.forEach((id, index) => {
      next[id] = index
    })
    this.#byBoard.set(boardKey, next)
    this.#persist()
  }

  #persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.#byBoard)))
    } catch {
      // Quota or a locked-down storage backend: the in-memory order still works
      // for this sitting.
    }
  }
}

export const boardOrder = new BoardOrderStore()
