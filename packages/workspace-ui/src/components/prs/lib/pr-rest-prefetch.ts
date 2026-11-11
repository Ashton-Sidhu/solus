/**
 * Read a pull request before it is opened, when the pointer or the keyboard
 * rests on its row.
 *
 * A rest is a sign of intent: the row is read once the pointer or the
 * highlight has stayed on it for `REST_PREFETCH_MS`, so the click that follows
 * opens a panel that already has its detail. Passing over rows, or walking the
 * list with the arrow keys, reads nothing. Only one row waits at a time: a
 * rest on another row replaces it.
 */
export const REST_PREFETCH_MS = 150

export class RestPrefetch<Key> {
  private waiting: { key: Key; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(
    private readonly read: (key: Key) => void,
    private readonly delayMs = REST_PREFETCH_MS,
  ) {}

  /** The pointer or the highlight came to this row. */
  rest(key: Key): void {
    if (this.waiting?.key === key) return
    this.cancel()
    const timer = setTimeout(() => {
      this.waiting = null
      this.read(key)
    }, this.delayMs)
    this.waiting = { key, timer }
  }

  /** The pointer or the focus left this row before the rest was long enough. */
  leave(key: Key): void {
    if (this.waiting?.key === key) this.cancel()
  }

  cancel(): void {
    if (this.waiting) clearTimeout(this.waiting.timer)
    this.waiting = null
  }
}
