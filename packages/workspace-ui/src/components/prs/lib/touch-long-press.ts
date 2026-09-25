/**
 * A touch press held long enough to mean "show me what I can do here".
 *
 * A row's context menu is its touch path to the same actions a desktop reaches
 * with a right-click or Shift, and `contextmenu` does not fire on a long-press
 * on every touch platform. Mouse and pen presses are ignored: they have their
 * own right-click. The click that ends a long-press is consumed, so lifting the
 * finger does not also open the row.
 */
export class TouchLongPress {
  #timer: ReturnType<typeof setTimeout> | null = null
  #hasFired = false

  constructor(
    private readonly onPress: (event: PointerEvent) => void,
    private readonly delayMs = 500,
  ) {}

  start(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return
    this.cancel()
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#hasFired = true
      this.onPress(event)
    }, this.delayMs)
  }

  /** The finger lifted, moved, or the browser took the gesture for a scroll. */
  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  /** True once, for the click that ends a long-press. */
  consumeClick(): boolean {
    const hasFired = this.#hasFired
    this.#hasFired = false
    return hasFired
  }
}
