import { createContext } from 'svelte'
import type { AgentMetadata } from '../../../shared/types'
import type { SettingsContext } from './settings.context.svelte'

/**
 * Frontend store for the backend-provided agent list. Session startup hydrates
 * this once from `start().agents`; UI components only read from this store.
 */
export class AgentContext {
  agents = $state<AgentMetadata[]>([])
  metadata: Record<string, AgentMetadata | null> = $derived(
    Object.fromEntries(this.agents.map((meta) => [meta.id, meta])),
  )

  private settings: SettingsContext

  constructor(settings: SettingsContext) {
    this.settings = settings
  }

  get activeMetadata(): AgentMetadata | null {
    return this.metadata[this.settings.activeAgent] ?? null
  }

  hydrate(agents: AgentMetadata[]): void {
    this.agents = agents
  }
}

export const [getAgentContext, setAgentContext] = createContext<AgentContext>()
