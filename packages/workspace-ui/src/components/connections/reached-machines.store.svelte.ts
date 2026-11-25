import { SvelteMap } from 'svelte/reactivity'
import { introducePair, type ChosenIntroducerHost } from '@solus/client-core/host-introducer'
import { serverConnections } from '@solus/client-core/server-connections'
import type { IntroducedHostsSummary } from '@solus/contracts/host-api'
import type { HostPairingsSnapshot } from '@solus/contracts/host-pairing'

interface Watcher {
  count: number
  stop: () => void
}

/**
 * The machines each host reaches as the owner: the pairings it holds, read through
 * the connection's pairing follower, and the hosts it was introduced to, read again
 * on each `host.listChanged`. A person's machines reach each other with no step;
 * the host map can also introduce two of them again, or forget an introduction.
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

  /**
   * Introduces two hosts this client owns, both ways, as a drop on the host map asks:
   * it also clears a Forget on either side (`introducePair`). Throws what failed, so
   * the map can say it; reads both hosts again either way.
   */
  async introduce(a: ReachHost, b: ReachHost): Promise<void> {
    try {
      await introducePair(chosenHost(a), chosenHost(b))
    } finally {
      await Promise.all([this.loadIntroductions(a.serverId), this.loadIntroductions(b.serverId)])
    }
  }

  /**
   * Forgets the introduction of two hosts on each side this client owns. A host that
   * forgot the other refuses it until the two are introduced again, so the automatic
   * introductions do not bring it back.
   */
  async forget(a: ReachHost, b: ReachHost, isOwner: (serverId: string) => boolean): Promise<void> {
    const sides = [[a, b], [b, a]].filter(([here]) => isOwner(here!.serverId))
    try {
      await Promise.all(sides.map(([here, there]) => serverConnections.apiFor(here!.serverId).hostIntroductionForget({ installationId: there!.installationId })))
    } finally {
      await Promise.all([this.loadIntroductions(a.serverId), this.loadIntroductions(b.serverId)])
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

/** A host this client owns, as an introduction names it. */
export interface ReachHost {
  serverId: string
  installationId: string
  label: string
}

function chosenHost(host: ReachHost): ChosenIntroducerHost {
  return { installationId: host.installationId, label: host.label, api: serverConnections.apiFor(host.serverId) }
}

export const reachedMachinesStore = new ReachedMachinesStore()
