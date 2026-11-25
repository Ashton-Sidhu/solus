import type { HostApi } from '@solus/client-core/host-api'
import { reachedMachines, type ReachedMachine } from '@solus/client-core/reached-machines'
import type { IntroducedHostsSummary } from '@solus/contracts/host-api'
import type { HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import { Listeners } from '../../lib/listeners'

/**
 * The machines each host reaches as the owner (docs/plans/host-reach.md), as the
 * desktop and web "Machines it reaches" section reads them: the pairings the host
 * holds, from its connection's pairing follower, and the hosts it was introduced
 * to, read again on each `host.listChanged` and each accepted connection.
 * Read-only: a person's machines reach each other with no step.
 */

export interface HostReachConnection {
  readonly api: Pick<HostApi, 'hostIntroductionsList'>
  readonly events: { subscribe(type: 'host.listChanged', listener: () => void): () => void }
  readonly pairings?: { snapshot(): HostPairingsSnapshot | null }
  readonly state: { readonly sessionGeneration: number }
  onAccepted(listener: () => void): () => void
}

export interface HostReachDeps {
  connectionFor(hostId: string): HostReachConnection | null
  /** This phone is connected to the host now and is its local owner (`canReadPairings`). */
  isOwner(hostId: string): boolean
  /** Fires when a host's readiness, server info, or pairings change. */
  changes: { subscribe(listener: () => void): () => void }
  now(): number
}

export type HostReachView =
  /** This phone is not the host's local owner, or is not connected to it. */
  | { kind: 'hidden' }
  | { kind: 'reading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; machines: readonly ReachedMachine[] }

const HIDDEN: HostReachView = { kind: 'hidden' }

/** The introductions of one server session; a read from an earlier one does not show. */
interface IntroductionsRead {
  sessionGeneration: number
  introductions: IntroducedHostsSummary | null
  error: string | null
}

interface Watcher {
  count: number
  connection: HostReachConnection | null
  stop: () => void
}

export class HostReach {
  readonly changes = new Listeners()
  private readonly reads = new Map<string, IntroductionsRead>()
  private readonly watchers = new Map<string, Watcher>()
  /** Bumped by each read, so an older answer never overwrites a newer one. */
  private readonly generations = new Map<string, number>()
  private readonly loading = new Set<string>()
  /** One view per host until something changes, so `useSyncExternalStore` sees a stable value. */
  private readonly views = new Map<string, HostReachView>()

  constructor(private readonly deps: HostReachDeps) {
    deps.changes.subscribe(() => {
      for (const hostId of this.watchers.keys()) this.follow(hostId)
      this.invalidate()
    })
  }

  viewOf = (hostId: string): HostReachView => {
    let view = this.views.get(hostId)
    if (!view) {
      view = this.read(hostId)
      this.views.set(hostId, view)
    }
    return view
  }

  /** Reads the host now and on each change. The returned function stops it. */
  watch(hostId: string): () => void {
    const existing = this.watchers.get(hostId)
    if (existing) existing.count++
    else {
      this.watchers.set(hostId, { count: 1, connection: null, stop: () => {} })
      this.follow(hostId)
    }
    return () => {
      const watcher = this.watchers.get(hostId)
      if (!watcher || --watcher.count > 0) return
      watcher.stop()
      this.watchers.delete(hostId)
    }
  }

  forgetHost(hostId: string): void {
    this.reads.delete(hostId)
    this.generations.delete(hostId)
    this.loading.delete(hostId)
    this.invalidate()
  }

  /** Follows the host's current connection, and reads it once this phone may and has no read of this server session. */
  private follow(hostId: string): void {
    const watcher = this.watchers.get(hostId)
    if (!watcher) return
    const connection = this.deps.connectionFor(hostId)
    if (watcher.connection !== connection) {
      watcher.stop()
      watcher.connection = connection
      if (!connection) watcher.stop = () => {}
      else {
        const stopChanges = connection.events.subscribe('host.listChanged', () => void this.load(hostId))
        const stopAccepted = connection.onAccepted(() => void this.load(hostId))
        watcher.stop = () => { stopChanges(); stopAccepted() }
      }
    }
    const read = this.reads.get(hostId)
    if (connection && read?.sessionGeneration !== connection.state.sessionGeneration && !this.loading.has(hostId)) void this.load(hostId)
  }

  private async load(hostId: string): Promise<void> {
    const connection = this.deps.connectionFor(hostId)
    // Only the host's local owner may read what it reaches.
    if (!connection || !this.deps.isOwner(hostId)) return
    const generation = (this.generations.get(hostId) ?? 0) + 1
    this.generations.set(hostId, generation)
    const sessionGeneration = connection.state.sessionGeneration
    const isCurrent = () => this.generations.get(hostId) === generation && this.deps.connectionFor(hostId) === connection
    this.loading.add(hostId)
    try {
      const introductions = await connection.api.hostIntroductionsList()
      if (!isCurrent()) return
      this.reads.set(hostId, { sessionGeneration, introductions, error: null })
    } catch {
      if (!isCurrent()) return
      const earlier = this.reads.get(hostId)
      this.reads.set(hostId, {
        sessionGeneration,
        introductions: earlier?.sessionGeneration === sessionGeneration ? earlier.introductions : null,
        error: 'Could not read the machines this host reaches.',
      })
    } finally {
      if (this.generations.get(hostId) === generation) this.loading.delete(hostId)
    }
    this.invalidate()
  }

  private read(hostId: string): HostReachView {
    const connection = this.deps.connectionFor(hostId)
    if (!connection || !this.deps.isOwner(hostId)) return HIDDEN
    const read = this.reads.get(hostId)
    const current = read?.sessionGeneration === connection.state.sessionGeneration ? read : null
    const machines = reachedMachines(connection.pairings?.snapshot() ?? null, current?.introductions ?? null, this.deps.now())
    if (current?.error && !machines.length) return { kind: 'error', message: current.error }
    if (!current?.introductions && !machines.length) return { kind: 'reading' }
    return { kind: 'loaded', machines }
  }

  private invalidate(): void {
    this.views.clear()
    this.changes.notify()
  }
}
