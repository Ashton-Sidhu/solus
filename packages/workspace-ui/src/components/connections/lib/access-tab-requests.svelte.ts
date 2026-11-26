/**
 * A request from outside Settings › Sharing & access to do one thing there, held
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

/**
 * Open "Approve a sign-in" (plans/035 §0.5): the palette's "Approve an app
 * sign-in", and a sign-in link, which names its sign-in (`requestId`).
 */
class ApproveSignInRequest {
  /** The host to approve on; null when nobody asks. */
  serverId = $state<string | null>(null)
  #requestId: string | null = null

  ask(serverId: string, requestId: string | null = null): void {
    this.#requestId = requestId
    this.serverId = serverId
  }

  /** Once for each ask on this host: the sign-in a link named, or null for the code field. Undefined when nobody asks. */
  take(serverId: string): { requestId: string | null } | undefined {
    if (this.serverId !== serverId) return undefined
    this.serverId = null
    return { requestId: this.#requestId }
  }
}

export const approveSignInRequest = new ApproveSignInRequest()
