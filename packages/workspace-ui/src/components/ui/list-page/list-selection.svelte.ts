import { SvelteSet } from 'svelte/reactivity'

/**
 * Multi-select state for a list page. The page owns one and hands it to
 * `ListSelectCheckbox` and `ListBulkBar`. Ids are whatever the page keys its
 * rows by.
 */
export class ListSelection {
  /** Currently selected row ids. Reactive so rows re-render on change. */
  readonly ids = new SvelteSet<string>()
  #lastSelectedId: string | null = null
  // Visible row order (in render order), kept in
  // sync by the page for Shift-range selection. Plain, non-reactive: it's only
  // read at toggle time, never rendered.
  #order: string[] = []

  get size(): number {
    return this.ids.size
  }
  /** Whether a selection is in progress (keeps every checkbox visible). */
  get active(): boolean {
    return this.ids.size > 0
  }
  has(id: string): boolean {
    return this.ids.has(id)
  }

  /** Replace the visible order the page renders, used to resolve Shift-ranges. */
  setOrder(ids: string[]): void {
    this.#order = ids
  }

  /** Toggle a row's membership, extending a contiguous range when Shift is held. */
  toggle(id: string, e: MouseEvent | KeyboardEvent): void {
    if (e.shiftKey && this.#lastSelectedId && this.#lastSelectedId !== id) {
      const a = this.#order.indexOf(this.#lastSelectedId)
      const b = this.#order.indexOf(id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        for (let i = lo; i <= hi; i++) this.ids.add(this.#order[i])
        this.#lastSelectedId = id
        return
      }
    }
    if (this.ids.has(id)) this.ids.delete(id)
    else this.ids.add(id)
    this.#lastSelectedId = id
  }

  selectAllVisible(): void {
    for (const id of this.#order) this.ids.add(id)
  }

  /** Drop rows that left the visible order, so an action never reaches a row
   *  the reader cannot see and the count never includes one. */
  retainVisible(): void {
    const visible = new Set(this.#order)
    for (const id of this.ids) if (!visible.has(id)) this.ids.delete(id)
  }

  clear(): void {
    this.ids.clear()
    this.#lastSelectedId = null
  }
}
