import { SolusApiError } from '../../admission/workspace-error'
import { createTokenBucketRateLimiter } from '../rate-limit'

const MAX_ACTIVE = 32
const MAX_ACTIVE_PER_ACTOR = 8
const MAX_PER_MINUTE_PER_ACTOR = 300

/** Bounds concurrent and per-minute work per actor; the global cap protects the connection pool. */
export class WorkspaceRequestBudgets {
  private readonly minute = createTokenBucketRateLimiter(MAX_PER_MINUTE_PER_ACTOR, 60_000)
  private readonly active = new Map<string, number>()
  private total = 0

  enter(actor: string): () => void {
    if (this.total >= MAX_ACTIVE) throw new SolusApiError(503, 'CAPABILITY_UNAVAILABLE', 'The service is busy. Try again shortly.', 1)
    const running = this.active.get(actor) ?? 0
    if (running >= MAX_ACTIVE_PER_ACTOR || !this.minute.allow(actor)) {
      throw new SolusApiError(429, 'RATE_LIMITED', 'The request budget is exhausted. Try again shortly.', 1)
    }
    this.total++
    this.active.set(actor, running + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.total--
      const remaining = (this.active.get(actor) ?? 1) - 1
      if (remaining > 0) this.active.set(actor, remaining)
      else this.active.delete(actor)
    }
  }
}
