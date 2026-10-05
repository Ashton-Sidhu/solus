import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { ROUTING_PROVIDERS } from '@solus/contracts/model-routing'
import type { AgentMetadata } from '@solus/contracts/types'

/** Every model Auto can route to: the installed routing providers' own models,
 *  in provider order. A category picks one of these and nothing else. */
export function routingModelsFor(agents: AgentMetadata[]): { value: string, label: string }[] {
  return ROUTING_PROVIDERS.flatMap(provider => {
    const agent = agents.find(agent => agent.id === provider && agent.available !== false)
    return agent?.models.map(model => ({ value: model.id, label: model.label })) ?? []
  })
}

interface RoutingModelsState {
  agents: AgentMetadata[]
  loading: boolean
  error: string
}

/**
 * The models one host can route to: a host capability. The routing choices
 * themselves are the person's (`modelRouting` in the personal settings), so
 * changing hosts shows what this host offers without changing them.
 */
class ModelRoutingStore {
  states = new SvelteMap<string, RoutingModelsState>()
  private loads = new Map<string, symbol>()

  watch(serverId: string): () => void {
    const stopStatus = serverConnections.onStatusChange((changedId, status) => {
      if (changedId === serverId && status === 'connected') void this.load(serverId)
    })
    void this.load(serverId)
    return stopStatus
  }

  async load(serverId: string): Promise<void> {
    const load = Symbol()
    this.loads.set(serverId, load)
    const previous = this.states.get(serverId)
    this.states.set(serverId, { agents: previous?.agents ?? [], loading: true, error: '' })
    try {
      const models = await serverConnections.apiFor(serverId).textGenerationSettingsGet()
      if (this.loads.get(serverId) !== load) return
      this.states.set(serverId, { agents: models.agents, loading: false, error: '' })
    } catch {
      if (this.loads.get(serverId) !== load) return
      this.states.set(serverId, { agents: previous?.agents ?? [], loading: false, error: 'Could not load this host’s models.' })
    } finally {
      if (this.loads.get(serverId) === load) this.loads.delete(serverId)
    }
  }
}

export const modelRoutingStore = new ModelRoutingStore()
