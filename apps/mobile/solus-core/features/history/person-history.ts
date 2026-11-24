import { PersonHistory, personHistoryHomeId, type PersonHistoryHome } from '@solus/client-core/person-history'
import { isSolusApiId } from '@solus/contracts/uplink'
import type { PersonHistoryEntry } from '@solus/contracts/person-history'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * The person's history on the phone (docs/plans/person-state.md): when they
 * last opened each record, read from their home. Signed in, the home is the
 * Solus API of the organization this phone works in; signed out, the phone's
 * default host. A phone has no device host. When the home becomes the Solus
 * API, the history of the host home before it goes into the account.
 */

export type PersonHistoryConnection = Pick<HostConnection, 'api' | 'events' | 'state'>

export interface MobilePersonHistoryDeps {
  /** Whether the person is signed in, and the Solus API connection of the organization this phone works in. */
  account(): { signedIn: boolean; solusApiId: string | null }
  /** The host this phone uses as its default; signed out, it keeps the history. */
  defaultHostId(): string | null
  /** The ready connection of a host or of the Solus API; null while the phone is not connected to it. */
  connection(serverId: string): PersonHistoryConnection | null
  /** Each change of the account, the hosts, or a connection's readiness. */
  onChange(listener: () => void): () => void
  batchDelayMs?: number
  now?(): number
}

export class MobilePersonHistory {
  /** Each change of a time, and each change of the home. */
  readonly changes = new Listeners()
  private readonly history: PersonHistory
  private readonly stopFollowing: () => void
  /** Bumped by each change, so `useSyncExternalStore` reads a new snapshot. */
  private changeCount = 0
  /** Whether the home answered at the last check: a return to ready reads it again. */
  private homeReady = false
  private homeConnection: PersonHistoryConnection | null = null
  private choiceQueued = false

  constructor(private readonly deps: MobilePersonHistoryDeps) {
    this.history = new PersonHistory({
      onChange: () => {
        this.changeCount += 1
        this.changes.notify()
      },
      batchDelayMs: deps.batchDelayMs,
      now: deps.now,
    })
    // After the change that called, so a change made while the home is chosen does not choose it again inside.
    this.stopFollowing = deps.onChange(() => {
      if (this.choiceQueued) return
      this.choiceQueued = true
      queueMicrotask(() => {
        this.choiceQueued = false
        this.chooseHome()
      })
    })
    this.chooseHome()
  }

  /** The snapshot a React reader keys on. */
  get version(): number {
    return this.changeCount
  }

  /** The connection id of the home; null while the phone reaches none. */
  get homeServerId(): string | null {
    return this.history.homeServerId
  }

  /** When the person last opened the record a key names, or null. */
  openedAt(key: string): number | null {
    return this.history.openedAt(key)
  }

  /** Every entry, newest open first. */
  entries(): PersonHistoryEntry[] {
    return this.history.entries()
  }

  /** The person opened a record now. */
  record(key: string): void {
    this.history.record(key)
  }

  /** Send the pending opens now. */
  flush(): Promise<void> {
    return this.history.flush()
  }

  dispose(): void {
    this.stopFollowing()
  }

  /** Choose the home again, and read it again when its connection is ready again. */
  chooseHome(): void {
    const { signedIn, solusApiId } = this.deps.account()
    const defaultHostId = this.deps.defaultHostId()
    const homeId = personHistoryHomeId({ signedIn, solusApiId, deviceHostId: null, defaultServerId: defaultHostId })
    const previousId = this.history.homeServerId
    const connection = homeId ? this.deps.connection(homeId) : null
    const ready = connection?.state.readiness === 'ready'
    if (homeId === previousId) {
      // A host dialed again is a new connection: the old one no longer answers.
      if (connection && connection !== this.homeConnection) {
        void this.history.useHome(null)
        this.useHome(homeId, connection, null)
        return
      }
      if (ready && !this.homeReady) void this.history.reload()
      this.homeReady = ready
      return
    }
    // Signing in, the host's history shows until the account answers. Signed out, the account's history goes at once.
    const signingIn = !!homeId && isSolusApiId(homeId) && !!previousId && !isSolusApiId(previousId)
    if (!connection && (signingIn || !previousId)) return
    // Signed in, the history the person kept on a host goes with them into their account.
    const carryHostId = previousId && !isSolusApiId(previousId) ? previousId : defaultHostId
    const carryFrom = homeId && isSolusApiId(homeId) && carryHostId ? this.deps.connection(carryHostId)?.api ?? null : null
    this.useHome(homeId, connection, carryFrom)
  }

  private useHome(homeId: string | null, connection: PersonHistoryConnection | null, carryFrom: PersonHistoryConnection['api'] | null): void {
    this.homeConnection = connection
    this.homeReady = connection?.state.readiness === 'ready'
    const home: PersonHistoryHome | null = homeId && connection ? { serverId: homeId, api: connection.api, events: connection.events } : null
    void this.history.useHome(home, carryFrom)
  }
}
