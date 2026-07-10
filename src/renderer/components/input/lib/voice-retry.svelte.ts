import type { VoiceErrorKind } from '../../../lib/voice-recorder.svelte'

const DELAYS_MS = [2_000, 5_000, 10_000]

export class VoiceRetryTracker {
  consecutiveFailures = $state(0)
  nextRetryAt = $state(0)
  exhausted = $derived(this.consecutiveFailures >= DELAYS_MS.length)

  note(errorKind: VoiceErrorKind): void {
    if (errorKind !== 'transient') {
      this.nextRetryAt = 0
      return
    }
    if (this.exhausted) return
    const delay = DELAYS_MS[this.consecutiveFailures]
    this.consecutiveFailures += 1
    this.nextRetryAt = Date.now() + delay
  }

  reset(): void {
    this.consecutiveFailures = 0
    this.nextRetryAt = 0
  }

  canRetry(now: number): boolean {
    return this.consecutiveFailures > 0 && !this.exhausted && now >= this.nextRetryAt
  }
}
