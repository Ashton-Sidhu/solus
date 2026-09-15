/** Editor and Pill can recover at different times. Union their session keys,
 * so shared activity counts once and activity seen by either window survives. */
export class DesktopActivityBadges {
  private readonly windows = new Map<number, Set<string>>()

  update(windowId: number, sessionKeys: string[]): number {
    this.windows.set(windowId, new Set(sessionKeys))
    return this.count
  }

  remove(windowId: number): number {
    this.windows.delete(windowId)
    return this.count
  }

  acknowledge(): void { this.windows.clear() }

  get count(): number {
    const sessions = new Set<string>()
    for (const keys of this.windows.values()) for (const key of keys) sessions.add(key)
    return sessions.size
  }
}
