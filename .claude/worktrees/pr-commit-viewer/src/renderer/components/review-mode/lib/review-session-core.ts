import type {
  PendingDisposition,
  ReviewOutcome,
  ReviewSessionEntry,
  ReviewSessionState,
} from '../../../../shared/review-session-types'

export const HOLD_MS = 5_000

export type PostableReviewOutcome = Exclude<ReviewOutcome, 'skipped'>

export interface DispositionPoster {
  /** The poster owns host-specific effects for the settled disposition. */
  post(disposition: PendingDisposition): Promise<void>
}

export interface ReviewSessionCoreEntry extends ReviewSessionEntry {
  /** A failed post remains pending so the session cannot silently claim success. */
  flushError: string | null
}

export interface ReviewSessionCoreState extends Omit<ReviewSessionState, 'entries'> {
  entries: ReviewSessionCoreEntry[]
}

export class ReviewSessionCore {
  state: ReviewSessionCoreState | null = null

  private lastVisibleAt: number | null = null
  private visible = true
  private readonly flushing = new Map<number, Promise<void>>()

  constructor(
    private readonly poster: DispositionPoster,
    private readonly now: () => number = Date.now,
  ) {}

  start(prNumbers: number[], at = this.now()): ReviewSessionCoreState {
    if (new Set(prNumbers).size !== prNumbers.length) {
      throw new Error('Review session PR numbers must be unique')
    }

    this.state = {
      entries: prNumbers.map((prNumber) => ({
        prNumber,
        outcome: null,
        openedAt: null,
        dwellMs: 0,
        flushError: null,
      })),
      cursor: 0,
      pending: [],
      startedAt: at,
      endedAt: null,
    }
    this.flushing.clear()
    this.visible = true
    this.lastVisibleAt = prNumbers.length === 0 ? null : at
    if (this.state.entries[0]) this.state.entries[0].openedAt = at
    return this.state
  }

  visit(index: number, at = this.now()): void {
    const state = this.requireState()
    if (index < 0 || index >= state.entries.length) return
    this.transitionTo(index, at)
  }

  next(at = this.now()): void {
    const state = this.requireState()
    if (state.cursor < 0 || state.cursor >= state.entries.length) return
    this.transitionTo(Math.min(state.cursor + 1, state.entries.length), at)
  }

  prev(at = this.now()): void {
    const state = this.requireState()
    if (state.entries.length === 0 || state.cursor <= 0) return
    this.transitionTo(Math.min(state.cursor - 1, state.entries.length - 1), at)
  }

  heartbeat(at = this.now()): void {
    const state = this.requireState()
    if (this.lastVisibleAt === null || state.cursor < 0 || state.cursor >= state.entries.length) return
    const entry = state.entries[state.cursor]
    entry.dwellMs += Math.max(0, at - this.lastVisibleAt)
    this.lastVisibleAt = at
  }

  markHidden(at = this.now()): void {
    this.heartbeat(at)
    this.visible = false
    this.lastVisibleAt = null
  }

  markVisible(at = this.now()): void {
    const state = this.requireState()
    if (this.visible) return
    this.visible = true
    if (state.cursor < 0 || state.cursor >= state.entries.length) return
    const entry = state.entries[state.cursor]
    if (entry.openedAt === null) entry.openedAt = at
    this.lastVisibleAt = at
  }

  dispose(
    prNumber: number,
    outcome: PostableReviewOutcome,
    body?: string,
    at = this.now(),
  ): PendingDisposition {
    const state = this.requireCurrent(prNumber)
    const entry = state.entries[state.cursor]
    if (entry.outcome !== null || state.pending.some((item) => item.prNumber === prNumber)) {
      throw new Error(`PR #${prNumber} already has a disposition`)
    }

    const disposition: PendingDisposition = { prNumber, outcome, heldAt: at }
    if (body !== undefined) disposition.body = body
    state.pending.push(disposition)
    entry.flushError = null
    this.transitionTo(Math.min(state.cursor + 1, state.entries.length), at)
    return disposition
  }

  undo(prNumber: number, at = this.now()): boolean {
    const state = this.requireState()
    const pendingIndex = state.pending.findIndex((item) => item.prNumber === prNumber)
    if (pendingIndex < 0 || state.pending[pendingIndex].heldAt + HOLD_MS <= at) return false

    state.pending.splice(pendingIndex, 1)
    const entryIndex = state.entries.findIndex((entry) => entry.prNumber === prNumber)
    state.entries[entryIndex].flushError = null
    this.transitionTo(entryIndex, at)
    return true
  }

  skip(prNumber: number, at = this.now()): void {
    const state = this.requireCurrent(prNumber)
    const entry = state.entries[state.cursor]
    if (entry.outcome !== null || state.pending.some((item) => item.prNumber === prNumber)) {
      throw new Error(`PR #${prNumber} already has a disposition`)
    }

    entry.outcome = 'skipped'
    entry.flushError = null
    this.transitionTo(Math.min(state.cursor + 1, state.entries.length), at)
  }

  async flushExpired(at = this.now()): Promise<void> {
    const state = this.requireState()
    const expired = state.pending.filter((item) => {
      const entry = this.entryFor(item.prNumber)
      return item.heldAt + HOLD_MS <= at && entry.flushError === null && !this.flushing.has(item.prNumber)
    })
    for (const disposition of expired) await this.flushOne(disposition)
  }

  /** Post one disposition immediately while preserving the hold for the rest. */
  async flush(prNumber: number): Promise<void> {
    const disposition = this.pendingFor(prNumber)
    if (disposition) await this.flushOne(disposition)
  }

  async flushAll(at = this.now()): Promise<void> {
    const state = this.requireState()
    this.markHidden(at)
    // Exit may accelerate dispositions that are still in their undo hold, but
    // it must not retry a provider rejection behind the user's back.
    const pending = state.pending.filter((disposition) => (
      this.entryFor(disposition.prNumber).flushError === null
    ))
    for (const disposition of pending) await this.flushOne(disposition)
    state.endedAt = at
  }

  /** Delay until the next automatic flush. Failed posts require a new user action. */
  nextExpiry(at = this.now()): number | null {
    const state = this.requireState()
    let next: number | null = null
    for (const disposition of state.pending) {
      const entry = this.entryFor(disposition.prNumber)
      if (entry.flushError !== null || this.flushing.has(disposition.prNumber)) continue
      const expiry = disposition.heldAt + HOLD_MS
      if (next === null || expiry < next) next = expiry
    }
    return next === null ? null : Math.max(0, next - at)
  }

  pendingFor(prNumber: number): PendingDisposition | null {
    return this.requireState().pending.find((item) => item.prNumber === prNumber) ?? null
  }

  private async flushOne(disposition: PendingDisposition): Promise<void> {
    const existing = this.flushing.get(disposition.prNumber)
    if (existing) return existing

    const operation = this.postAndSettle(disposition)
    this.flushing.set(disposition.prNumber, operation)
    try {
      await operation
    } finally {
      this.flushing.delete(disposition.prNumber)
    }
  }

  private async postAndSettle(disposition: PendingDisposition): Promise<void> {
    const state = this.requireState()
    if (!state.pending.includes(disposition)) return
    const entry = this.entryFor(disposition.prNumber)
    try {
      await this.poster.post(disposition)
      const pendingIndex = state.pending.indexOf(disposition)
      if (pendingIndex >= 0) state.pending.splice(pendingIndex, 1)
      entry.outcome = disposition.outcome
      entry.flushError = null
    } catch (error) {
      entry.flushError = error instanceof Error ? error.message : String(error)
    }
  }

  private transitionTo(index: number, at: number): void {
    const state = this.requireState()
    this.heartbeat(at)
    state.cursor = index
    if (index >= 0 && index < state.entries.length) {
      const entry = state.entries[index]
      if (entry.openedAt === null) entry.openedAt = at
      this.lastVisibleAt = this.visible ? at : null
    } else {
      this.lastVisibleAt = null
    }
  }

  private entryFor(prNumber: number): ReviewSessionCoreEntry {
    const entry = this.requireState().entries.find((item) => item.prNumber === prNumber)
    if (!entry) throw new Error(`PR #${prNumber} is not in this review session`)
    return entry
  }

  private requireCurrent(prNumber: number): ReviewSessionCoreState {
    const state = this.requireState()
    if (state.entries[state.cursor]?.prNumber !== prNumber) {
      throw new Error(`PR #${prNumber} is not the current review entry`)
    }
    return state
  }

  private requireState(): ReviewSessionCoreState {
    if (!this.state) throw new Error('Review session has not started')
    return this.state
  }
}
