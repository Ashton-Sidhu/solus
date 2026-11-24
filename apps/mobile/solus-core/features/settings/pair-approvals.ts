import type { PairApprovalDecision, PairApprovalRequest } from '@solus/contracts/add-machine'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * The open approval requests of the hosts this phone is connected to
 * (docs/plans/add-machine-card.md, "The approval request"). Another machine asks
 * a host to pair without a code; the host's owner approves or denies it. Only a
 * principal with `host.local.reach` reads and decides them, so the phone watches
 * only the hosts where it holds that permission. The approval notice and the
 * list on a host's page both read this store.
 */

export interface OpenPairApproval {
  hostId: string
  request: PairApprovalRequest
}

export interface PairApprovalsDeps {
  /** The hosts this phone is connected to now. */
  readyConnections: () => HostConnection[]
  /** Whether this phone holds `host.local.reach` on a host. */
  mayReach: (hostId: string) => boolean
  /** Fires when the hosts, their connections, or their permissions change. */
  onChange: (listener: () => void) => () => void
}

interface Watch {
  connection: HostConnection
  /** A new session on the same link reads the list again: the topic's recovery is a reload. */
  generation: number
  approvals: readonly PairApprovalRequest[]
  stop: () => void
}

const NONE: readonly PairApprovalRequest[] = []

export class PairApprovals {
  readonly changes = new Listeners()
  private readonly watches = new Map<string, Watch>()
  private openList: readonly OpenPairApproval[] = []
  private decidingIds: ReadonlySet<string> = new Set()
  private readonly stopFollowing: () => void

  constructor(private readonly deps: PairApprovalsDeps) {
    this.stopFollowing = deps.onChange(() => this.sync())
    this.sync()
  }

  /** Every open request, oldest first. The same array until the list changes. */
  get open(): readonly OpenPairApproval[] {
    return this.openList
  }

  /** The requests whose answer is on the way. */
  get deciding(): ReadonlySet<string> {
    return this.decidingIds
  }

  /** One host's open requests. The same array until that host's list changes. */
  approvalsOf(hostId: string): readonly PairApprovalRequest[] {
    return this.watches.get(hostId)?.approvals ?? NONE
  }

  /** Whether this phone watches the host: it is connected there with `host.local.reach`. */
  isWatching(hostId: string): boolean {
    return this.watches.has(hostId)
  }

  /** Approves or denies one request. False: it expired or another client answered it first. */
  async decide(hostId: string, requestId: string, decision: PairApprovalDecision): Promise<boolean> {
    const watch = this.watches.get(hostId)
    if (!watch) throw new Error('This host cannot be reached now.')
    if (this.decidingIds.has(requestId)) return false
    this.setDeciding(requestId, true)
    try {
      const done = await watch.connection.api.hostsPairApprovalDecide(requestId, decision)
      // The request is closed either way: decided now, or no longer open.
      if (this.watches.get(hostId) === watch) this.setApprovals(watch, watch.approvals.filter((request) => request.requestId !== requestId))
      return done
    } finally {
      this.setDeciding(requestId, false)
    }
  }

  dispose(): void {
    this.stopFollowing()
    for (const watch of this.watches.values()) watch.stop()
    this.watches.clear()
    this.rebuild()
  }

  private sync(): void {
    const wanted = new Map<string, HostConnection>()
    for (const connection of this.deps.readyConnections()) {
      if (this.deps.mayReach(connection.hostId)) wanted.set(connection.hostId, connection)
    }
    let changed = false
    for (const [hostId, watch] of this.watches) {
      const connection = wanted.get(hostId)
      if (connection === watch.connection && connection.state.sessionGeneration === watch.generation) continue
      watch.stop()
      this.watches.delete(hostId)
      changed = true
    }
    for (const [hostId, connection] of wanted) {
      if (!this.watches.has(hostId)) this.watch(hostId, connection)
    }
    if (changed) this.rebuild()
  }

  private watch(hostId: string, connection: HostConnection): void {
    const watch: Watch = { connection, generation: connection.state.sessionGeneration, approvals: NONE, stop: () => {} }
    watch.stop = connection.events.subscribe('host.pairApprovalsChanged', ({ approvals }) => {
      if (this.watches.get(hostId) === watch) this.setApprovals(watch, approvals)
    })
    this.watches.set(hostId, watch)
    connection.api.hostsPairApprovals().then(
      (approvals) => { if (this.watches.get(hostId) === watch) this.setApprovals(watch, approvals) },
      // An older host has no approval requests, and a host that refuses this phone has none for it.
      () => {},
    )
  }

  private setApprovals(watch: Watch, approvals: readonly PairApprovalRequest[]): void {
    watch.approvals = approvals.length ? approvals : NONE
    this.rebuild()
  }

  private setDeciding(requestId: string, isDeciding: boolean): void {
    const next = new Set(this.decidingIds)
    if (isDeciding) next.add(requestId)
    else next.delete(requestId)
    this.decidingIds = next
    this.changes.notify()
  }

  private rebuild(): void {
    this.openList = [...this.watches.entries()]
      .flatMap(([hostId, watch]) => watch.approvals.map((request) => ({ hostId, request })))
      .sort((a, b) => a.request.requestedAt - b.request.requestedAt)
    this.changes.notify()
  }
}
