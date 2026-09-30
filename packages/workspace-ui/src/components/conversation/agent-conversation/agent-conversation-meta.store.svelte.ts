import { SvelteMap } from 'svelte/reactivity'
import type { SessionMeta } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'
import { readSessionMeta } from '@solus/client-core/session-meta'

type SolusApi = HostApi

/**
 * Indexed metadata for agents shown in conversation cards: slug title, provider,
 * model and working directory. Where each exchange stands comes from the host's
 * orchestrator, not from here.
 *
 * These agents have no bound tab, so their metadata can't come from the tab
 * registry — it is hydrated from the session index, and re-hydrated when the
 * index names a tracked agent. An agent lives on whichever server its caller's
 * tab is bound to, so each agent is tracked against that tab's api and the topic
 * subscription is made once per distinct host.
 *
 * A transcript mounts every one of its cards in the same frame, so hydration
 * reads go through the batching meta reader: one `getSessionInfos` per host per
 * frame rather than one `getSessionInfo` per card.
 */
class AgentConversationMetaStore {
  private metas = new SvelteMap<string, SessionMeta>()
  private apiByAgent = new Map<string, SolusApi>()
  private serverIdByAgent = new Map<string, string>()
  private apiByServerId = new Map<string, SolusApi>()
  private consumers = new Map<string, number>()
  private hydrationGeneration = new Map<string, number>()
  private subscribedServerIds = new Set<string>()
  /** One stable hosts view per store, so the meta reader keeps one batch queue
   *  for it. Answers with the api a card handed us for that host. */
  private readonly hosts = {
    resolveId: (serverId: string) => serverConnections.resolveId(serverId),
    apiFor: (serverId: string): Pick<HostApi, 'getSessionInfos'> =>
      this.apiByServerId.get(serverId) ?? serverConnections.apiFor(serverId),
  }

  constructor(
    private readonly eventsFor: (serverId: string) => HostEventSubscriber = (serverId) => serverConnections.eventsFor(serverId),
  ) {}

  private subscribe(serverId: string): void {
    if (this.subscribedServerIds.has(serverId)) return
    this.subscribedServerIds.add(serverId)
    this.eventsFor(serverId).subscribe('session.indexChanged', (event) => {
      // Only tracked agents, so the map stays bounded by agents actually shown.
      for (const sessionId of event.sessionIds ?? []) {
        if (this.apiByAgent.has(sessionId)) void this.hydrate(sessionId)
      }
    })
  }

  /** Retain an agent while at least one mounted card can display it. */
  retain(agentSessionId: string, api: SolusApi, serverId: string | undefined): () => void {
    // An agent with no named host cannot be hydrated (see `hydrate`), so there
    // is nothing for a subscription to feed either.
    if (serverId) {
      const resolvedServerId = serverConnections.resolveId(serverId)
      this.subscribe(resolvedServerId)
      this.apiByServerId.set(resolvedServerId, api)
    }
    const count = this.consumers.get(agentSessionId) ?? 0
    this.consumers.set(agentSessionId, count + 1)
    if (count === 0) {
      this.apiByAgent.set(agentSessionId, api)
      if (serverId) this.serverIdByAgent.set(agentSessionId, serverId)
      this.hydrationGeneration.set(agentSessionId, (this.hydrationGeneration.get(agentSessionId) ?? 0) + 1)
      void this.hydrate(agentSessionId)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.consumers.get(agentSessionId) ?? 1) - 1
      if (remaining > 0) {
        this.consumers.set(agentSessionId, remaining)
        return
      }
      this.consumers.delete(agentSessionId)
      this.apiByAgent.delete(agentSessionId)
      this.serverIdByAgent.delete(agentSessionId)
      this.metas.delete(agentSessionId)
      this.hydrationGeneration.set(agentSessionId, (this.hydrationGeneration.get(agentSessionId) ?? 0) + 1)
    }
  }

  private async hydrate(agentSessionId: string): Promise<void> {
    const api = this.apiByAgent.get(agentSessionId)
    const serverId = this.serverIdByAgent.get(agentSessionId)
    if (!api || !serverId) return
    const generation = this.hydrationGeneration.get(agentSessionId) ?? 0
    const meta = await readSessionMeta(serverId, agentSessionId, this.hosts)
    if (
      !meta ||
      !this.consumers.has(agentSessionId) ||
      this.apiByAgent.get(agentSessionId) !== api ||
      this.hydrationGeneration.get(agentSessionId) !== generation
    ) return
    this.metas.set(agentSessionId, meta)
  }

  metaFor(agentSessionId: string): SessionMeta | undefined {
    return this.metas.get(agentSessionId)
  }

  trackedCount(): number {
    return this.consumers.size
  }
}

export const agentConversationMeta = new AgentConversationMetaStore()
export { AgentConversationMetaStore }
