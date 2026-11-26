/**
 * A request from outside a host's Access tab to do one thing there, held
 * outside the tab as `mcpPageRequest` is, so the tab takes it when it mounts
 * or while it is open.
 */
class AccessTabRequest {
  /** The host to act on; null when nobody asks. */
  serverId = $state<string | null>(null)

  ask(serverId: string): void {
    this.serverId = serverId
  }

  /** True once for each ask on this host. */
  take(serverId: string): boolean {
    if (this.serverId !== serverId) return false
    this.serverId = null
    return true
  }
}

/** Make a pairing code: the Add machine card's "Show the code on <name>" and the palette's "Show pairing code" (docs/plans/add-machine-card.md). */
export const pairCodeRequest = new AccessTabRequest()

/** Show "Use Solus in other apps": the palette's command of that name (plans/035 §10). */
export const outsideAppsRequest = new AccessTabRequest()
