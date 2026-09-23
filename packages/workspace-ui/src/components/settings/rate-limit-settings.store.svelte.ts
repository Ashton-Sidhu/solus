import type { RateLimitBehavior } from '@solus/contracts/host-config'
import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'

interface RateLimitSettingsState {
  behavior: RateLimitBehavior | null
  saving: boolean
  error: string
  revision: number
}

export class RateLimitSettingsStore {
  states = new SvelteMap<string, RateLimitSettingsState>()
  private watches = new Map<string, { count: number; stop: () => void }>()

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      const stopConfig = serverConnections.eventsFor(serverId).subscribe('config.changed', ({ config }) => {
        const state = this.states.get(serverId)
        this.states.set(serverId, { behavior: config.rateLimitBehavior ?? null, saving: state?.saving ?? false, error: config.rateLimitBehavior ? '' : 'Update or restart this host to configure rate limits.', revision: (state?.revision ?? 0) + 1 })
      })
      const stopStatus = serverConnections.onStatusChange((hostId, status) => {
        if (hostId !== serverId) return
        if (status === 'connected') void this.load(serverId)
        else {
          const state = this.states.get(serverId)
          if (state) this.states.set(serverId, { ...state, behavior: null, error: 'Host disconnected.', revision: state.revision + 1 })
        }
      })
      watch = { count: 0, stop: () => { stopConfig(); stopStatus() } }
      this.watches.set(serverId, watch)
      void this.load(serverId)
    }
    watch.count++
    return () => { if (--watch.count === 0) { watch.stop(); this.watches.delete(serverId) } }
  }

  async load(serverId: string): Promise<void> {
    const state = this.states.get(serverId) ?? { behavior: null, saving: false, error: '', revision: 0 }
    const revision = state.revision + 1
    this.states.set(serverId, { ...state, revision })
    try {
      const { config } = await serverConnections.apiFor(serverId).configGet()
      if (this.states.get(serverId)?.revision !== revision) return
      this.states.set(serverId, { ...state, saving: this.states.get(serverId)!.saving, behavior: config.rateLimitBehavior ?? null, error: config.rateLimitBehavior ? '' : 'Update or restart this host to configure rate limits.', revision: revision + 1 })
    } catch {
      if (this.states.get(serverId)?.revision !== revision) return
      this.states.set(serverId, { ...state, saving: this.states.get(serverId)!.saving, revision, error: 'Could not load rate limit behavior.' })
    }
  }

  async save(serverId: string, behavior: RateLimitBehavior): Promise<void> {
    const state = this.states.get(serverId)
    if (!state || !state.behavior || state.saving || state.error) return
    this.states.set(serverId, { ...state, saving: true, error: '', revision: state.revision + 1 })
    try {
      const { config } = await serverConnections.apiFor(serverId).configUpdate({ rateLimitBehavior: behavior })
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, behavior: current.revision === state.revision + 1 ? config.rateLimitBehavior : current.behavior, saving: false })
    } catch {
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, saving: false, error: 'Could not save rate limit behavior.' })
    }
  }
}

export const rateLimitSettingsStore = new RateLimitSettingsStore()
