import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { IntroducedHostsSummary } from '@solus/contracts/host-api'
import type { HostPairingsSnapshot } from '@solus/contracts/host-pairing'

interface Watcher {
  count: number
  stop: () => void
}

/**
 * The machines each host reaches as the owner (docs/plans/host-reach.md): the
 * pairings it holds, read through the connection's pairing follower, and the hosts
 * it was introduced to, read again on each `host.listChanged`. Read-only: a
 * person's machines reach each other with no step.
 */
class ReachedMachinesStore {
  /** Absent until the host answers. */
  readonly pairingsByServer = new SvelteMap<string, HostPairingsSnapshot | null>()
  readonly introductionsByServer = new SvelteMap<string, IntroducedHostsSummary>()
  readonly errorByServer = new SvelteMap<string, string>()
  private readonly watchers = new Map<string, Watcher>()
  /** Bumped by each read, so an older answer never overwrites a newer one. */
  private readonly generations = new Map<string, number>()

  /** Reads the host now and on each change. The returned function stops it. */
  watch(serverId: string): () => void {
    const existing = this.watchers.get(serverId)
    if (existing) existing.count++
    else {
      // Read from the current connection each time: a reconnect can replace its follower.
      const readPairings = () => this.pairingsByServer.set(serverId, serverConnections.connectionFor(serverId)?.pairings?.snapshot() ?? null)
      const stopPairings = serverConnections.connectionFor(serverId)?.pairings?.subscribe(readPairings) ?? (() => {})
      readPairings()
      const stopChanges = serverConnections.eventsFor(serverId).subscribe('host.listChanged', () => void this.loadIntroductions(serverId))
      const stopReadiness = serverConnections.onReadinessChange((changedId, readiness) => {
        if (changedId !== serverId || readiness !== 'ready') return
        readPairings()
        void this.loadIntroductions(serverId)
      })
      this.watchers.set(serverId, { count: 1, stop: () => { stopPairings(); stopChanges(); stopReadiness() } })
      void this.loadIntroductions(serverId)
    }
    return () => {
      const watcher = this.watchers.get(serverId)
      if (!watcher || --watcher.count > 0) return
      watcher.stop()
      this.watchers.delete(serverId)
    }
  }

  private async loadIntroductions(serverId: string): Promise<void> {
    const generation = (this.generations.get(serverId) ?? 0) + 1
    this.generations.set(serverId, generation)
    try {
      const summary = await serverConnections.apiFor(serverId).hostIntroductionsList()
      if (this.generations.get(serverId) !== generation) return
      this.introductionsByServer.set(serverId, summary)
      this.errorByServer.delete(serverId)
    } catch {
      if (this.generations.get(serverId) !== generation) return
      this.errorByServer.set(serverId, 'Could not read the machines this host reaches.')
    }
  }
}

export const reachedMachinesStore = new ReachedMachinesStore()
