import { createAppContext } from './create-app-context'
import { MODEL_PROFILES, providerModelsFor, type AgentMetadata } from '@solus/contracts/types'
import { modelProfilesStore } from '../updates/model-profiles.store.svelte'
import type { SettingsContext } from './settings.context.svelte'

/**
 * Frontend store for the backend-provided agent list. Session startup hydrates
 * this once from `start().agents`; UI components only read from this store.
 */
export class AgentContext {
  // primary-host by decision pending WP6 host framing (docs/plans/multi-host-parity.md)
  agents = $state<AgentMetadata[]>([])
  /** A host's model list, once one is in effect, replaces the models the host
   *  listed at start: the list can change while the app runs. */
  metadata: Record<string, AgentMetadata | null> = $derived.by(() => {
    const hasHostModelList = modelProfilesStore.revision > 0
    return Object.fromEntries(this.agents.map((meta) => [
      meta.id,
      hasHostModelList && MODEL_PROFILES[meta.id] ? { ...meta, ...providerModelsFor(meta.id) } : meta,
    ]))
  })

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

export const [getAgentContext, setAgentContext] = createAppContext<AgentContext>('agent')
