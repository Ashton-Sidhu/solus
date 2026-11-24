import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostCatalog } from '@solus/client-core/host-catalog'
import {
  PersonHistory,
  appHistoryKey,
  personHistoryHomeId,
  type PersonHistoryChange,
  type PersonHistoryHomeChoice,
} from '@solus/client-core/person-history'
import { isSolusApiId } from '@solus/contracts/uplink'
import type { PersonHistoryEntry } from '@solus/contracts/person-history'

/**
 * The person's history on desktop and web (docs/plans/person-state.md): when
 * they last opened each record, read from their home. Signed in, the home is
 * the Solus API of the window's organization, in the person's own scope;
 * signed out, the device host. At sign-in the device host's history is carried
 * into the Solus API. The servers store says when the account or the
 * organization changes (`follow`). A reader asks one key and is told when that
 * key moves.
 */
class PersonHistoryStore {
  /** The time of each key, as the home holds it with this client's opens applied. */
  private readonly times = new SvelteMap<string, number>()
  private readonly history = new PersonHistory({ onChange: (change) => this.apply(change) })

  constructor() {
    serverConnections.onReadinessChange((serverId, readiness) => {
      if (readiness === 'ready' && serverId === this.history.homeServerId) void this.history.reload()
    })
  }

  /** When the person last opened the record a key names, or null. */
  openedAt(key: string): number | null {
    return this.times.get(key) ?? null
  }

  /** Every entry, newest open first. */
  entries(): PersonHistoryEntry[] {
    return [...this.times].map(([key, openedAt]) => ({ key, openedAt })).sort((a, b) => b.openedAt - a.openedAt || a.key.localeCompare(b.key))
  }

  /** The person opened a record now. */
  record(key: string): void {
    this.history.record(key)
  }

  /** The installation id of the host this client reaches as `serverId`: how every client names that machine. */
  machineIdOf(serverId: string): string {
    return hostCatalog.find(serverId)?.installationId ?? serverId
  }

  /** The key of an app on the host this client reaches as `serverId`. */
  appKey(serverId: string, appId: string): string {
    return appHistoryKey(this.machineIdOf(serverId), appId)
  }

  /** Read the history from the home the account state names (docs/plans/person-state.md §3). */
  follow(choice: Pick<PersonHistoryHomeChoice, 'signedIn' | 'solusApiId'>): void {
    const deviceHostId = serverConnections.deviceHostId()
    const homeId = personHistoryHomeId({ ...choice, deviceHostId, defaultServerId: serverConnections.defaultServerId() })
    if (homeId === this.history.homeServerId) return
    // Signed in, the history the person kept on the device host goes with them into their account.
    const carryFrom = homeId && isSolusApiId(homeId) && deviceHostId ? serverConnections.apiFor(deviceHostId) : null
    void this.history.useHome(
      homeId ? { serverId: homeId, api: serverConnections.apiFor(homeId), events: serverConnections.eventsFor(homeId) } : null,
      carryFrom,
    )
  }

  private apply(change: PersonHistoryChange): void {
    if (change === 'reset') {
      this.times.clear()
      return
    }
    for (const key of change) {
      const openedAt = this.history.openedAt(key)
      if (openedAt === null) this.times.delete(key)
      else this.times.set(key, openedAt)
    }
  }
}

export const personHistoryStore = new PersonHistoryStore()
