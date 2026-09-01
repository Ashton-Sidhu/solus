import { SvelteSet } from 'svelte/reactivity'
import { createContext } from 'svelte'
import type { Task } from '../../shared/task-types'

/**
 * Multi-select state for the Tasks list view. Owned by TasksPage and shared down
 * to every TaskCard via context, so the selection no longer threads through
 * EpicGroup (a pure pass-through) as `selectedIds` / `selectionActive` /
 * `onToggleSelect` props. Board view never selects, so its cards simply ignore it.
 */
export class TasksSelectionStore {
  /** Currently selected task ids. Reactive so cards re-render on change. */
  readonly ids = new SvelteSet<string>()
  #lastSelectedId: string | null = null
  // Visible card order (epic children + standalone, in render order), kept in
  // sync by TasksPage for Shift-range selection. Plain, non-reactive: it's only
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

  /** Replace the visible order TasksPage renders, used to resolve Shift-ranges. */
  setOrder(ids: string[]): void {
    this.#order = ids
  }

  /** Toggle a card's membership, extending a contiguous range when Shift is held. */
  toggle(task: Task, e: MouseEvent | KeyboardEvent): void {
    if (e.shiftKey && this.#lastSelectedId && this.#lastSelectedId !== task.id) {
      const a = this.#order.indexOf(this.#lastSelectedId)
      const b = this.#order.indexOf(task.id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        for (let i = lo; i <= hi; i++) this.ids.add(this.#order[i])
        this.#lastSelectedId = task.id
        return
      }
    }
    if (this.ids.has(task.id)) this.ids.delete(task.id)
    else this.ids.add(task.id)
    this.#lastSelectedId = task.id
  }

  selectAllVisible(): void {
    for (const id of this.#order) this.ids.add(id)
  }

  clear(): void {
    this.ids.clear()
    this.#lastSelectedId = null
  }
}

export const [getTasksSelection, setTasksSelection] =
  createContext<TasksSelectionStore>()
