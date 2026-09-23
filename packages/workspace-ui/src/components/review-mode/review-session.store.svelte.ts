import type { PendingDisposition } from '@solus/contracts/review-session-types'
import {
  ReviewSessionCore,
  type DispositionPoster,
  type PostableReviewOutcome,
  type ReviewSessionCoreState,
} from './lib/review-session-core'

export interface ReviewVisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface StartReviewSessionOptions {
  /** Pull request numbers in queue order. */
  numbers: number[]
  poster: DispositionPoster
  /** Called when a pull request becomes the current entry, by any command:
   *  start, a visit, a step, or a disposition that advances the queue. */
  onEnter?: (prNumber: number) => void
  now?: () => number
  visibilitySource?: ReviewVisibilitySource | null
}

/** Reactive ownership around the pure core: one expiry timer and one visibility listener. */
export class ReviewSessionStore {
  state = $state<ReviewSessionCoreState | null>(null)

  private core: ReviewSessionCore | null = null
  private now: () => number = Date.now
  private onEnter: (prNumber: number) => void = () => {}
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private visibilitySource: ReviewVisibilitySource | null = null

  get currentEntry() {
    if (!this.state) return null
    return this.state.entries[this.state.cursor] ?? null
  }

  get position(): string {
    if (!this.state || this.state.entries.length === 0) return '0/0'
    const visiblePosition = Math.min(this.state.cursor + 1, this.state.entries.length)
    return `${visiblePosition}/${this.state.entries.length}`
  }

  start(options: StartReviewSessionOptions): void {
    this.detach()
    this.state = null
    this.now = options.now ?? Date.now
    this.onEnter = options.onEnter ?? (() => {})
    this.core = new ReviewSessionCore(options.poster, this.now)
    this.core.start(options.numbers, this.now())

    this.sync()

    const defaultVisibilitySource = document
    this.visibilitySource = options.visibilitySource === undefined
      ? defaultVisibilitySource
      : options.visibilitySource
    this.visibilitySource?.addEventListener('visibilitychange', this.handleVisibilityChange)
    if (this.visibilitySource?.hidden) {
      this.core.markHidden(this.now())
      this.sync()
    }
    this.scheduleFlush()
  }

  visit(index: number): void {
    this.requireCore().visit(index, this.now())
    this.sync()
  }

  next(): void {
    this.requireCore().next(this.now())
    this.sync()
  }

  prev(): void {
    this.requireCore().prev(this.now())
    this.sync()
  }

  dispose(prNumber: number, outcome: PostableReviewOutcome, body?: string): PendingDisposition {
    const disposition = this.requireCore().dispose(prNumber, outcome, body, this.now())
    this.sync()
    this.scheduleFlush()
    return disposition
  }

  undo(prNumber: number): boolean {
    const undone = this.requireCore().undo(prNumber, this.now())
    this.sync()
    this.scheduleFlush()
    return undone
  }

  skip(prNumber: number): void {
    this.requireCore().skip(prNumber, this.now())
    this.sync()
  }

  heartbeat(): void {
    this.requireCore().heartbeat(this.now())
    this.sync()
  }

  markHidden(): void {
    this.requireCore().markHidden(this.now())
    this.sync()
  }

  markVisible(): void {
    this.requireCore().markVisible(this.now())
    this.sync()
  }

  pendingFor(prNumber: number): PendingDisposition | null {
    return this.state?.pending.find((item) => item.prNumber === prNumber) ?? null
  }

  async flushExpired(): Promise<void> {
    await this.requireCore().flushExpired(this.now())
    this.sync()
    this.scheduleFlush()
  }

  async flush(prNumber: number): Promise<void> {
    await this.requireCore().flush(prNumber)
    this.sync()
    this.scheduleFlush()
  }

  async flushAll(): Promise<void> {
    await this.requireCore().flushAll(this.now())
    this.sync()
    this.detach()
  }

  /** Removes host listeners/timers; session exits should call flushAll first. */
  detach(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.visibilitySource?.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.visibilitySource = null
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.visibilitySource?.hidden) this.markHidden()
    else this.markVisible()
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const delay = this.core?.nextExpiry(this.now()) ?? null
    if (delay === null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushExpired()
    }, delay)
  }

  /** Every command ends here, so this is the one place the current entry can
   *  change — and so the one place to announce it. */
  private sync(): void {
    const before = this.currentEntry?.prNumber ?? null
    this.copyCoreState()
    const after = this.currentEntry?.prNumber ?? null
    if (after !== null && after !== before) this.onEnter(after)
  }

  private copyCoreState(): void {
    const source = this.core?.state ?? null
    if (!source) {
      this.state = null
      return
    }
    if (!this.state || !sameQueue(this.state, source)) {
      this.state = cloneState(source)
      return
    }

    this.state.cursor = source.cursor
    this.state.startedAt = source.startedAt
    this.state.endedAt = source.endedAt
    for (let index = 0; index < source.entries.length; index++) {
      const targetEntry = this.state.entries[index]
      const sourceEntry = source.entries[index]
      targetEntry.outcome = sourceEntry.outcome
      targetEntry.openedAt = sourceEntry.openedAt
      targetEntry.dwellMs = sourceEntry.dwellMs
      targetEntry.flushError = sourceEntry.flushError
    }
    this.state.pending.splice(0, this.state.pending.length, ...source.pending.map((item) => ({ ...item })))
  }

  private requireCore(): ReviewSessionCore {
    if (!this.core) throw new Error('Review session has not started')
    return this.core
  }
}

function sameQueue(left: ReviewSessionCoreState, right: ReviewSessionCoreState): boolean {
  return left.entries.length === right.entries.length
    && left.entries.every((entry, index) => entry.prNumber === right.entries[index].prNumber)
}

function cloneState(state: ReviewSessionCoreState): ReviewSessionCoreState {
  return {
    entries: state.entries.map((entry) => ({ ...entry })),
    cursor: state.cursor,
    pending: state.pending.map((item) => ({ ...item })),
    startedAt: state.startedAt,
    endedAt: state.endedAt,
  }
}

export const reviewSessionStore = new ReviewSessionStore()
