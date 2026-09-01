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

  constructor(private readonly ttlMs: number) {}

  async read(load: () => Promise<T>, opts: { force?: boolean } = {}): Promise<T> {
    if (!opts.force && this.value !== undefined && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.value
    }
    if (this.inFlight) return this.inFlight

    const flight = load()
      .then((value) => {
        this.seed(value)
        return value
      })
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
   *  carried this field inside a larger payload. */
  seed(value: T): void {
    this.value = value
    this.fetchedAt = Date.now()
  }

  clear(): void {
    this.value = undefined
    this.fetchedAt = 0
  }
}
