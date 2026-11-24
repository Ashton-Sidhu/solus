/**
 * A request from outside the Access tab to make a pairing code there, held
 * outside the tab as `mcpPageRequest` is, so the tab takes it when it mounts
 * or while it is open: the Add machine card's "Show the code on <name>" and the
 * palette's "Show pairing code" (docs/plans/add-machine-card.md).
 */
class PairCodeRequest {
  /** The host to make a code on; null when nobody asks. */
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

export const pairCodeRequest = new PairCodeRequest()
