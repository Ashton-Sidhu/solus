import { SvelteMap } from 'svelte/reactivity'
import { z } from 'zod'
import type { BoardRanks } from './lib/board-order'

const STORAGE_KEY = 'solus.tasks.board-ranks'

/**
 * Where each project's manually-placed board cards live.
 *
 * Order is a per-viewer reading of a shared list — "this is what *I* am doing
 * next" — so it is kept client-side and keyed by project, rather than written
 * back to the task record. That also lets an upstream GitHub ticket be dragged
 * beside a local task: neither provider has to own a field for it.
 *
 * The trade is that the order does not follow you to another machine. If it
 * should, this class is the seam: a rank per task is already the shape a
 * `board_rank` column wants, and only `setColumnOrder` would change — a
 * fractional key between the drop's two neighbours, so one drag writes one row
 * instead of renumbering the column.
 */
export class BoardOrderStore {
  #byProject = new SvelteMap<string, BoardRanks>()

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const storedRanks = z.record(z.string(), z.record(z.string(), z.number())).parse(JSON.parse(raw))
        for (const [projectKey, ranks] of Object.entries(storedRanks)) {
          this.#byProject.set(projectKey, ranks)
        }
      }
    } catch {
      // A malformed or unavailable store is not worth failing the board over —
      // the columns simply fall back to the page's sort.
    }
  }

  /** A project's card ranks (empty until something is dragged). */
  ranksFor(projectKey: string | null): BoardRanks {
    if (!projectKey) return {}
    return this.#byProject.get(projectKey) ?? {}
  }

  /**
   * Record a column's cards in the order they now read, top to bottom.
   *
   * Callers pass the column exactly as it will render, so the rank *is* the
   * array index — there is no position to compute. Ranks only ever compare
   * within a column, so numbering columns independently costs nothing.
   */
  setColumnOrder(projectKey: string | null, orderedIds: string[]): void {
    if (!projectKey) return
    const next = { ...this.ranksFor(projectKey) }
    orderedIds.forEach((id, index) => {
      next[id] = index
    })
    this.#byProject.set(projectKey, next)
    this.#persist()
  }

  #persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.#byProject)))
    } catch {
      // Quota or a locked-down storage backend: the in-memory order still works
      // for this sitting.
    }
  }
}

export const boardOrder = new BoardOrderStore()
