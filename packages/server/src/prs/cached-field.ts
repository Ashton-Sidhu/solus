/**
 * One remembered answer, with a lifetime and a single flight.
 *
 * Every pull-request read leaves this process for a code host whose limits are
 * low, so two clients asking the same question at the same time must cost one
 * request, not two. `read` therefore does three things in order: serve a value
 * that is still young, join a request that is already running, or start one.
 *
 * `force` skips only the *age* check. A forced read still joins a flight that is
 * already in the air, because a second identical request would answer the same
 * thing a moment later at twice the cost.
 */
export class CachedField<T> {
  private value: T | undefined
  private fetchedAt = 0
  private inFlight: Promise<T> | null = null

  /**
   * `accept` decides between what is held and what just arrived. Without one
   * the newer arrival always wins; a field whose answers can land out of order
   * — a listing row seeded while a direct read is in flight — supplies one so a
   * late, older answer cannot replace a newer one.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly accept: (previous: T | undefined, next: T) => T = (_previous, next) => next,
  ) {}

  async read(load: () => Promise<T>, opts: { force?: boolean } = {}): Promise<T> {
    if (!opts.force && this.value !== undefined && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.value
    }
    if (this.inFlight) return this.inFlight

    const flight = load()
      .then((value) => this.seed(value))
      .finally(() => {
        // Only clear the flight this call started: a `clear()` during the
        // request may already have replaced it, and dropping that one would
        // leave a newer read with nothing to join.
        if (this.inFlight === flight) this.inFlight = null
      })
    this.inFlight = flight
    return flight
  }

  /** Record a value obtained elsewhere — a mutation's response, or a read that
   *  carried this field inside a larger payload. Answers with what is held
   *  afterwards, which is the arrival unless `accept` kept the previous one. */
  seed(value: T): T {
    this.value = this.accept(this.value, value)
    this.fetchedAt = Date.now()
    return this.value
  }

  /** What is held, however old. For surfaces that would rather show the last
   *  answer than nothing, and must not cost a request to find out. */
  peek(): T | undefined {
    return this.value
  }

  /** Expire rather than drop: the next `read` goes to the host, but `peek`
   *  still has the last answer to show until it lands. */
  clear(): void {
    this.fetchedAt = 0
  }
}
