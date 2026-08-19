import type { StatusCardState } from '@solus/contracts/types'

/**
 * Elapsed time per setup step.
 *
 * The card is replaced wholesale on every stage transition and its steps carry
 * no timestamps, so duration can't be derived from the payload. What the figure
 * actually means is "how long the user waited on this step", which is precisely
 * what the renderer observes — so watch the status transitions here instead of
 * widening `StatusCardStep` for a value main would have to invent anyway.
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
      if (step.status !== 'done' && step.status !== 'error') continue
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

/** `0.4s`, `2.1s`, `1m 04s` — the rail is narrow, so nothing wider. */
export function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}
