/** Union session keys from live renderer senders so shared activity counts once
 * and a renderer reload cannot leave a stale badge contribution behind. */
export class DesktopActivityBadges {
  private readonly senders = new Map<number, Set<string>>()

  update(senderId: number, sessionKeys: string[]): number {
    this.senders.set(senderId, new Set(sessionKeys))
    return this.count
  }

  remove(senderId: number): number {
    this.senders.delete(senderId)
    return this.count
  }

  acknowledge(): void { this.senders.clear() }

  get count(): number {
    const sessions = new Set<string>()
    for (const keys of this.senders.values()) for (const key of keys) sessions.add(key)
    return sessions.size
  }
}
