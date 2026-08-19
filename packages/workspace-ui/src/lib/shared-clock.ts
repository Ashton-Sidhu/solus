export class SharedClock {
  private consumers = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private subscribers = new Set<(now: number) => void>()

  constructor(private readonly intervalMs: number) {}

  retain(): () => void {
    this.consumers += 1
    if (this.consumers === 1) {
      document.addEventListener('visibilitychange', this.handleVisibility)
      this.syncVisibility()
    }
    let hasReleased = false
    return () => {
      if (hasReleased) return
      hasReleased = true
      this.consumers = Math.max(0, this.consumers - 1)
      if (this.consumers > 0) return
      document.removeEventListener('visibilitychange', this.handleVisibility)
      this.stop()
    }
  }

  subscribe(update: (now: number) => void): () => void {
    const release = this.retain()
    this.subscribers.add(update)
    update(Date.now())
    return () => {
      this.subscribers.delete(update)
      release()
    }
  }

  private handleVisibility = (): void => this.syncVisibility()

  private syncVisibility(): void {
    if (document.visibilityState === 'hidden') {
      this.stop()
      return
    }
    this.publish()
    if (!this.timer) this.timer = setInterval(() => this.publish(), this.intervalMs)
  }

  private publish(): void {
    const now = Date.now()
    for (const subscriber of this.subscribers) subscriber(now)
  }

  private stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}

export const messageTimestampClock = new SharedClock(60_000)
export const liveActivityClock = new SharedClock(1_000)
