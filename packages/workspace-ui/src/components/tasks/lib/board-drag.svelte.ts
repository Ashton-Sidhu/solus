import type { TaskStatus } from '@solus/contracts/task-types'

/** Where a lifted card would land: which column, and at what index among that
 *  column's remaining visible cards. */
export interface DropTarget {
  status: TaskStatus
  index: number
}

export interface DragState {
  taskId: string
  from: TaskStatus
  /** The lifted card's own box, so the floating copy is the same size as the
   *  hole it left rather than a generic ghost. */
  width: number
  height: number
  /** Grab point inside the card, so it stays under the same pixel it was
   *  picked up by however far it travels. */
  offsetX: number
  offsetY: number
  x: number
  y: number
}

interface Wiring {
  /** The board's columns, left to right. */
  columns: () => TaskStatus[]
  /** A column's visible task ids, in render order. */
  idsIn: (status: TaskStatus) => string[]
  onDrop: (taskId: string, from: TaskStatus, target: DropTarget) => void
}

// A press has to travel this far before it becomes a drag, so a click on a card
// still opens it and a slightly unsteady hand doesn't reorder the board.
const DRAG_THRESHOLD_PX = 5

/**
 * Pointer-driven card dragging for the kanban board ("Tasks page" spec, board
 * layout).
 *
 * HTML5 drag-and-drop can only say *which element* you are over; the spec's
 * board also has to say *where between two cards* the drop will land, and to
 * render the lifted card tilted under the cursor. Both need live geometry, so
 * this drives the drag from raw pointer events and measures the cards itself.
 */
export class BoardDrag {
  /** The in-flight drag, or null when nothing is moving. */
  drag = $state<DragState | null>(null)
  /** The slot the drop would take. Survives a moment outside any column so the
   *  preview doesn't flicker when the cursor crosses a gap. */
  target = $state<DropTarget | null>(null)
  /** The card that just moved, ringed briefly so the eye can follow it. */
  flashId = $state<string | null>(null)

  #wiring: Wiring
  #cards = new Map<string, HTMLElement>()
  #columns = new Map<TaskStatus, HTMLElement>()
  #pending: { taskId: string; from: TaskStatus; startX: number; startY: number; rect: DOMRect } | null = null
  #onMove?: (event: PointerEvent) => void
  #onUp?: () => void
  #flashTimer?: ReturnType<typeof setTimeout>
  #justDragged = false

  constructor(wiring: Wiring) {
    this.#wiring = wiring
  }

  /** Svelte action: give the controller a card's element to measure. */
  card = (node: HTMLElement, taskId: string) => {
    this.#cards.set(taskId, node)
    return { destroy: () => this.#cards.delete(taskId) }
  }

  /** Svelte action: give the controller a column well's element to hit-test. */
  column = (node: HTMLElement, status: TaskStatus) => {
    this.#columns.set(status, node)
    return { destroy: () => this.#columns.delete(status) }
  }

  /** Arm a drag on pointer-down. Nothing visible happens until the pointer
   *  actually travels — see `DRAG_THRESHOLD_PX`. */
  press(event: PointerEvent, taskId: string, from: TaskStatus): void {
    if (event.button !== 0) return
    const node = this.#cards.get(taskId)
    if (!node) return
    this.#pending = { taskId, from, startX: event.clientX, startY: event.clientY, rect: node.getBoundingClientRect() }
    this.#onMove = (moveEvent: PointerEvent) => this.#move(moveEvent)
    this.#onUp = () => this.#release()
    window.addEventListener('pointermove', this.#onMove)
    window.addEventListener('pointerup', this.#onUp)
    window.addEventListener('pointercancel', this.#onUp)
  }

  /**
   * Whether the click now arriving is the tail of a drag rather than a real
   * click. A pointer-up always fires a click, and opening the task you just
   * finished rearranging is the one thing a drag must not do.
   */
  swallowsClick(): boolean {
    if (!this.#justDragged) return false
    this.#justDragged = false
    return true
  }

  /** Ring a card as if it had just been dropped there — the keyboard moves use
   *  this so a card moved without the pointer is just as easy to follow. */
  flash(taskId: string): void {
    this.flashId = taskId
    clearTimeout(this.#flashTimer)
    this.#flashTimer = setTimeout(() => {
      if (this.flashId === taskId) this.flashId = null
    }, 650)
  }

  destroy(): void {
    this.#detach()
    clearTimeout(this.#flashTimer)
  }

  #move(event: PointerEvent): void {
    const pending = this.#pending
    if (!pending) return

    if (!this.drag) {
      const travelled =
        Math.abs(event.clientX - pending.startX) + Math.abs(event.clientY - pending.startY)
      if (travelled < DRAG_THRESHOLD_PX) return
      // Text selection and an I-beam across a board being rearranged read as a
      // bug, so the whole document commits to the drag for its duration.
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'grabbing'
      this.drag = {
        taskId: pending.taskId,
        from: pending.from,
        width: pending.rect.width,
        height: pending.rect.height,
        offsetX: pending.startX - pending.rect.left,
        offsetY: pending.startY - pending.rect.top,
        x: event.clientX,
        y: event.clientY,
      }
      this.target = {
        status: pending.from,
        index: Math.max(0, this.#wiring.idsIn(pending.from).indexOf(pending.taskId)),
      }
      return
    }

    this.drag.x = event.clientX
    this.drag.y = event.clientY
    this.target = this.#hitTest(event.clientX, event.clientY) ?? this.target
  }

  /**
   * Which column and slot the cursor is over. The column is whichever one the
   * cursor is horizontally inside, falling back to the nearest — dragging above
   * the columns or into the gap between two still has an obvious intent.
   */
  #hitTest(x: number, y: number): DropTarget | null {
    const drag = this.drag
    if (!drag) return null

    let inside: TaskStatus | null = null
    let nearest: TaskStatus | null = null
    let bestDistance = Infinity
    for (const status of this.#wiring.columns()) {
      const node = this.#columns.get(status)
      if (!node) continue
      const rect = node.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right) inside = status
      const distance = Math.abs(x - (rect.left + rect.right) / 2)
      if (distance < bestDistance) {
        bestDistance = distance
        nearest = status
      }
    }

    const status = inside ?? nearest
    if (!status) return null

    // Index by card midpoints: the drop lands above the first card whose middle
    // the cursor has passed, which is the rule the placeholder draws.
    const ids = this.#wiring.idsIn(status).filter((id) => id !== drag.taskId)
    let index = ids.length
    for (let i = 0; i < ids.length; i++) {
      const node = this.#cards.get(ids[i])
      if (!node) continue
      const rect = node.getBoundingClientRect()
      if (y < rect.top + rect.height / 2) {
        index = i
        break
      }
    }
    return { status, index }
  }

  #release(): void {
    this.#detach()
    const drag = this.drag
    const target = this.target
    this.#pending = null
    this.drag = null
    this.target = null
    if (!drag || !target) return
    this.#justDragged = true
    this.#wiring.onDrop(drag.taskId, drag.from, target)
    this.flash(drag.taskId)
  }

  #detach(): void {
    if (this.#onMove) window.removeEventListener('pointermove', this.#onMove)
    if (this.#onUp) {
      window.removeEventListener('pointerup', this.#onUp)
      window.removeEventListener('pointercancel', this.#onUp)
    }
    this.#onMove = undefined
    this.#onUp = undefined
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }
}
