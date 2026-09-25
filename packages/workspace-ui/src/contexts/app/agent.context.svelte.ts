import { createAppContext } from './create-app-context'
import type { AgentMetadata, AgentUsageLimits } from '@solus/contracts/types'
import type { SettingsContext } from './settings.context.svelte'
import { serverConnections } from '@solus/client-core/server-connections'

/** Well inside the host's 15-minute idle window, so its poll stays awake. */
const USAGE_REFRESH_INTERVAL_MS = 60_000

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
  private readonly usageReadAtByServerId = new Map<string, number>()

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
   *  snapshots arrive through the `usage.limitsChanged` topic. Every mounted
   *  project panel asks when its tab becomes active, and the topic already
   *  delivers changes, so one read per host per minute is enough. Usage is a
   *  machine's (its agents' seats), so a window with no machine reads nothing. */
  async refreshUsage(now = Date.now()): Promise<void> {
    const serverId = serverConnections.defaultMachineId()
    if (!serverId) return
    if (now - (this.usageReadAtByServerId.get(serverId) ?? -Infinity) < USAGE_REFRESH_INTERVAL_MS) return
    this.usageReadAtByServerId.set(serverId, now)
    try {
      this.applyUsage(await serverConnections.apiFor(serverId).usageLimits())
    } catch (error) {
      this.usageReadAtByServerId.delete(serverId)
      throw error
    }
  }
}

export const [getAgentContext, setAgentContext] = createAppContext<AgentContext>('agent')
