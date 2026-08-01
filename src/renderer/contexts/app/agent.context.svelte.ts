import { createContext } from 'svelte'
import type { AgentMetadata, AgentUsageLimits } from '../../../shared/types'
import type { SettingsContext } from './settings.context.svelte'

/**
 * Frontend store for the backend-provided agent list. Session startup hydrates
 * this once from `start().agents`; UI components only read from this store.
 */
export class AgentContext {
  agents = $state<AgentMetadata[]>([])
  /** Subscription quota per provider, keyed by `AgentId`. Providers that don't
   *  report quota are simply absent. */
  usage = $state<Record<string, AgentUsageLimits>>({})
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

  applyUsage(snapshots: AgentUsageLimits[]): void {
    // Per-key assign, not an object spread: a new record reference would
    // invalidate every reader on each 5-minute poll.
    for (const snapshot of snapshots) this.usage[snapshot.provider] = snapshot
  }

  /** Also tells the backend someone is watching — its poll self-suspends when
   *  nobody asks for a while. */
  async refreshUsage(): Promise<void> {
    this.applyUsage(await window.solus.usageLimits())
  }
}

export const [getAgentContext, setAgentContext] = createContext<AgentContext>()
