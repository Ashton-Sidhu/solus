import type { StatusCardState } from '@solus/contracts/types'

/**
 * Elapsed time per setup step, for a card the client makes itself (a pull
 * request checkout, a continue-in-worktree, a conflict resolution). Those
 * steps carry no host times, so the figure is "how long the user waited on
 * this step", which is what the renderer observes as the statuses change.
 *
 * Resets when the card id changes; a card that arrives already finished simply
 * has no timings and the column stays empty.
 */
export class SetupStepTiming {
  private cardId: string | null = null
  private startedAt = new Map<string, number>()
  private elapsed = $state(new Map<string, number>())

  /** Call on every card change, before reading durations. */
  observe(card: StatusCardState, now: number): void {
    if (card.id !== this.cardId) {
      this.cardId = card.id
      this.startedAt = new Map()
      this.elapsed = new Map()
    }
    let changed = false
    for (const step of card.steps) {
      if (step.status === 'active') {
        if (!this.startedAt.has(step.id)) this.startedAt.set(step.id, now)
        continue
      }
      if (step.status === 'pending' || step.status === 'skipped') continue
      const started = this.startedAt.get(step.id)
      if (started === undefined || this.elapsed.has(step.id)) continue
      this.elapsed.set(step.id, now - started)
      changed = true
    }
    // `elapsed` is a plain Map in $state, so reassign to notify readers.
    if (changed) this.elapsed = new Map(this.elapsed)
  }

  msFor(stepId: string): number | undefined {
    return this.elapsed.get(stepId)
  }

  /** Sum across every step that reported one — the collapsed summary's figure. */
  get totalMs(): number {
    let total = 0
    for (const ms of this.elapsed.values()) total += ms
    return total
  }
}
