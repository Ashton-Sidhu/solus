import type { WorkspaceItem } from './workspace-items'

/** Rest before the card opens, and the grace it keeps after the pointer leaves.
 *  The same grace a menu bar uses: once a card is open, crossing to another row
 *  swaps its contents with no delay and no second animation. */
const REST_DELAY = 380
const CLOSE_GRACE = 120

/**
 * When the hover peek is showing, and for which row.
 *
 * Hovering never selects — this is the whole of the peek's state, deliberately
 * separate from the ledger's selection, so peeking cannot lose your place.
 */
export class PeekHover {
  item = $state<WorkspaceItem | null>(null)
  /** The row the card hangs off. It is anchored to the row, never the pointer. */
  anchor = $state<HTMLElement | null>(null)
  /** Held ⇧ (or opened from the keyboard): the card gains pointer events and
   *  stays until Esc or a click elsewhere. */
  pinned = $state(false)

  #openTimer: ReturnType<typeof setTimeout> | undefined
  #closeTimer: ReturnType<typeof setTimeout> | undefined

  get open(): boolean {
    return this.item !== null
  }

  /** Pointer came to rest on a row. */
  enter(item: WorkspaceItem, anchor: HTMLElement): void {
    clearTimeout(this.#closeTimer)
    if (this.pinned) return
    if (this.open) {
      this.#show(item, anchor)
      return
    }
    clearTimeout(this.#openTimer)
    this.#openTimer = setTimeout(() => this.#show(item, anchor), REST_DELAY)
  }

  /** Pointer left a row — either on its way out of the ledger, or on its way to
   *  the next row, which `enter` will claim before the grace expires. */
  leave(): void {
    clearTimeout(this.#openTimer)
    if (this.pinned) return
    clearTimeout(this.#closeTimer)
    this.#closeTimer = setTimeout(() => this.close(), CLOSE_GRACE)
  }

  /** Keyboard parity: the same card, pinned, on the focused row. */
  toggle(item: WorkspaceItem, anchor: HTMLElement): void {
    if (this.open) {
      this.close()
      return
    }
    this.#show(item, anchor)
    this.pinned = true
  }

  /**
   * Touch parity: the same card with no row to hang off, raised as a sheet.
   *
   * Pinned on arrival because there is no pointer to keep it open — a finger
   * taps and leaves, so the only ways out are the backdrop, Escape and Open.
   */
  raise(item: WorkspaceItem): void {
    clearTimeout(this.#openTimer)
    clearTimeout(this.#closeTimer)
    this.item = item
    this.anchor = null
    this.pinned = true
  }

  /** Arrow keys move the focused row; an open card follows it. */
  follow(item: WorkspaceItem, anchor: HTMLElement | null): void {
    if (!this.open || !anchor) return
    this.#show(item, anchor)
  }

  pin(): void {
    if (this.open) this.pinned = true
  }

  close(): void {
    clearTimeout(this.#openTimer)
    clearTimeout(this.#closeTimer)
    this.item = null
    this.anchor = null
    this.pinned = false
  }

  #show(item: WorkspaceItem, anchor: HTMLElement): void {
    clearTimeout(this.#openTimer)
    clearTimeout(this.#closeTimer)
    this.item = item
    this.anchor = anchor
  }
}
