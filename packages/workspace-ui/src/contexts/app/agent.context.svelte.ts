import { createAppContext } from './create-app-context'
import type { AgentMetadata, AgentUsageLimits } from '@solus/contracts/types'
import type { SettingsContext } from './settings.context.svelte'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * Frontend store for the backend-provided agent list. Session startup hydrates
 * this once from `start().agents`; UI components only read from this store.
 */
export class AgentContext {
  // primary-host by decision pending WP6 host framing (docs/plans/multi-host-parity.md)
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
   *  nobody asks for a while. Reads the new-work default host; other hosts'
   *  snapshots arrive through the `usage.limitsChanged` topic. */
  async refreshUsage(): Promise<void> {
    const serverId = serverConnections.defaultServerId()
    if (!serverId) return
    this.applyUsage(await serverConnections.apiFor(serverId).usageLimits())
  }
}

export const [getAgentContext, setAgentContext] = createAppContext<AgentContext>('agent')
