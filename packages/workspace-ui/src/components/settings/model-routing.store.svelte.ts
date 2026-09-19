import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { ModelRouting } from '@solus/contracts/model-routing'
import type { AgentMetadata } from '@solus/contracts/types'

interface RoutingState {
  config: ModelRouting | null
  agents: AgentMetadata[]
  loading: boolean
  saving: boolean
  error: string
  revision: number
}

class ModelRoutingStore {
  states = new SvelteMap<string, RoutingState>()
  private loads = new Map<string, symbol>()

  watch(serverId: string): () => void {
    const stopConfig = serverConnections.eventsFor(serverId).subscribe('config.changed', ({ config }) => {
      const state = this.states.get(serverId)
      if (state) this.states.set(serverId, { ...state, config: config.modelRouting, revision: state.revision + 1 })
    })
    const stopStatus = serverConnections.onStatusChange((changedId, status) => {
      if (changedId === serverId && status === 'connected') void this.load(serverId)
    })
    void this.load(serverId)
    return () => { stopConfig(); stopStatus() }
  }

  async load(serverId: string): Promise<void> {
    const load = Symbol()
    this.loads.set(serverId, load)
    const previous = this.states.get(serverId)
    const revision = (previous?.revision ?? 0) + 1
    this.states.set(serverId, { config: null, agents: [], saving: false, ...previous, loading: true, error: '', revision })
    const api = serverConnections.apiFor(serverId)
    try {
      const [snapshot, models] = await Promise.all([api.configGet(), api.textGenerationSettingsGet()])
      if (this.loads.get(serverId) !== load) return
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current,
        config: current.revision === revision ? snapshot.config.modelRouting : current.config,
        agents: models.agents, loading: false,
        error: snapshot.config.modelRouting ? '' : 'Update this host to configure model routing.',
      })
    } catch {
      if (this.loads.get(serverId) !== load) return
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, loading: false, error: 'Could not load model routing.' })
    } finally {
      if (this.loads.get(serverId) === load) this.loads.delete(serverId)
    }
  }

  async save(serverId: string, config: ModelRouting): Promise<void> {
    const state = this.states.get(serverId)
    if (!state?.config || state.saving || state.loading) return
    const revision = state.revision + 1
    this.states.set(serverId, { ...state, saving: true, error: '', revision })
    try {
      const snapshot = await serverConnections.apiFor(serverId).configUpdate({ modelRouting: config })
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, saving: false,
        config: current.revision === revision ? snapshot.config.modelRouting : current.config,
      })
    } catch {
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, saving: false, error: 'Could not save model routing. Try again.' })
    }
  }
}

export const modelRoutingStore = new ModelRoutingStore()
