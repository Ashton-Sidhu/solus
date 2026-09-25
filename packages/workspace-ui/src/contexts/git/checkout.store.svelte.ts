import { SvelteMap } from 'svelte/reactivity'
import { hostKey, splitHostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import type { CheckoutChange, CheckoutSnapshot, CheckoutState } from '@solus/contracts/checkout'
import type { GitCheckout } from '@solus/contracts/types'

/** The one client projection of checkout identity. Status scans, session
 * attachments, and browser pages may supply fallbacks, never overwrite it. */
export class CheckoutStore {
  private states = new SvelteMap<string, CheckoutState>()
  private generations = new Map<string, string>()
  private retired = new Map<string, Set<string>>()
  private requests = new Map<string, number>()
  private pending = new Map<string, Promise<void>>()

  get(serverId: string, cwd: string): CheckoutState | undefined {
    return this.states.get(hostKey(serverId, cwd))
  }

  resolve(serverId: string, cwd: string, fallback: GitCheckout | null): GitCheckout | null {
    const state = this.get(serverId, cwd)
    return state ? state.checkout : fallback
  }

  apply(serverId: string, change: CheckoutChange): void {
    if (!this.acceptGeneration(serverId, change.generation)) return
    this.adopt(serverId, change.state)
  }

  applySnapshot(serverId: string, snapshot: CheckoutSnapshot): void {
    if (!this.acceptGeneration(serverId, snapshot.generation)) return
    for (const state of snapshot.states) this.adopt(serverId, state)
  }

  async refresh(serverId: string, paths?: string[]): Promise<void> {
    const request = this.requests.get(serverId) ?? 0
    const requestedPaths = paths ?? [...this.states.keys()].map(splitHostKey).filter((key) => key.serverId === serverId).map((key) => key.path)
    const snapshot = await serverConnections.apiFor(serverId).checkoutSnapshot(requestedPaths)
    if ((this.requests.get(serverId) ?? 0) !== request) return
    this.applySnapshot(serverId, snapshot)
  }

  ensure(serverId: string, cwd: string): Promise<void> {
    if (!cwd || cwd === '~' || this.get(serverId, cwd)) return Promise.resolve()
    const key = hostKey(serverId, cwd)
    const existing = this.pending.get(key)
    if (existing) return existing
    const pending = this.refresh(serverId, [cwd]).finally(() => this.pending.delete(key))
    this.pending.set(key, pending)
    return pending
  }

  subscribe(): () => void {
    const recover = (serverId: string) => {
      void this.refresh(serverId).catch(() => {})
    }
    const stopEvents = subscribeAllHosts('git.checkoutChanged', (serverId, change) => this.apply(serverId, change))
    const stopConnections = serverConnections.onStatusChange((serverId, status) => {
      // Invalidate requests from the previous transport even on a failed reconnect.
      this.requests.set(serverId, (this.requests.get(serverId) ?? 0) + 1)
      if (status === 'connected') recover(serverId)
    })
    for (const serverId of serverConnections.connectedServerIds()) recover(serverId)
    return () => { stopEvents(); stopConnections() }
  }

  private adopt(serverId: string, state: CheckoutState): void {
    const key = hostKey(serverId, state.cwd)
    const previous = this.states.get(key)
    if (previous && previous.revision >= state.revision) return
    this.states.set(key, state)
  }

  private acceptGeneration(serverId: string, generation: string): boolean {
    const current = this.generations.get(serverId)
    if (current === generation) return true
    if (this.retired.get(serverId)?.has(generation)) return false
    if (current) {
      const retired = this.retired.get(serverId) ?? new Set<string>()
      retired.add(current)
      this.retired.set(serverId, retired)
      for (const key of this.states.keys()) if (splitHostKey(key).serverId === serverId) this.states.delete(key)
    }
    this.generations.set(serverId, generation)
    return true
  }
}

export const checkoutStore = new CheckoutStore()
