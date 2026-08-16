/**
 * Client activity leases (dispatch-client step 7): clients report foreground
 * visibility on a TTL heartbeat, and the host skips expensive freshness work
 * — watch-fired git status recomputes — while nobody is looking. A lease is
 * evidence, not a subscription: it expires on its own clock, so a client that
 * dies mid-lease costs at most one TTL of extra polling.
 */

const LEASE_TTL_MS = 20_000

export class ActivityLeases {
  private foregroundByClient = new Map<string, number>()

  report(clientId: string, foreground: boolean, now = Date.now()): void {
    if (foreground) this.foregroundByClient.set(clientId, now)
    else this.foregroundByClient.delete(clientId)
  }

  drop(clientId: string): void {
    this.foregroundByClient.delete(clientId)
  }

  hasForegroundLease(now = Date.now()): boolean {
    for (const [clientId, leasedAt] of this.foregroundByClient) {
      if (now - leasedAt <= LEASE_TTL_MS) return true
      this.foregroundByClient.delete(clientId)
    }
    return false
  }
}

export const activityLeases = new ActivityLeases()
