import { SvelteMap } from 'svelte/reactivity'
import type { SessionMeta, SessionStatus } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'
import { stampSessionMeta } from '@solus/client-core/session-meta'

type SolusApi = HostApi

/**
 * Live status + indexed metadata for agents shown in conversation cards.
 *
 * These agents have no bound tab, so their state can't come from the tab registry —
 * it rides the host's `session.statusChanged` event, with `getSessionInfo`
 * hydration for the slower facts (slug title, model, cwd) and re-hydration when
 * the session index names a tracked agent. An agent lives on whichever server its
 * caller's tab is bound to, so each agent is tracked against that tab's api and
 * the topic subscription is made once per distinct host.
 */
class AgentConversationStatusStore {
  private statuses = new SvelteMap<string, SessionStatus>()
  private metas = new SvelteMap<string, SessionMeta>()
  private apiByAgent = new Map<string, SolusApi>()
  private serverIdByAgent = new Map<string, string>()
  private consumers = new Map<string, number>()
  private hydrationGeneration = new Map<string, number>()
  private subscribedServerIds = new Set<string>()

  constructor(
    private readonly eventsFor: (serverId: string) => HostEventSubscriber = (serverId) => serverConnections.eventsFor(serverId),
  ) {}

  private subscribe(serverId: string): void {
    if (this.subscribedServerIds.has(serverId)) return
    this.subscribedServerIds.add(serverId)
    const events = this.eventsFor(serverId)
    events.subscribe('session.statusChanged', (event) => {
      // Only tracked agents, so the maps stay bounded by agents actually shown.
      if (this.apiByAgent.has(event.sessionId)) this.statuses.set(event.sessionId, event.status)
    })
    events.subscribe('session.indexChanged', (event) => {
      for (const sessionId of event.sessionIds ?? []) {
        if (this.apiByAgent.has(sessionId)) void this.hydrate(sessionId)
      }
    })
  }

  /** Retain an agent while at least one mounted card can display it. */
  retain(agentSessionId: string, api: SolusApi, serverId: string | undefined): () => void {
    // An agent with no named host cannot be hydrated (see `hydrate`), so there
    // is nothing for a subscription to feed either.
    if (serverId) this.subscribe(serverConnections.resolveId(serverId))
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
      this.statuses.delete(agentSessionId)
      this.metas.delete(agentSessionId)
      this.hydrationGeneration.set(agentSessionId, (this.hydrationGeneration.get(agentSessionId) ?? 0) + 1)
    }
  }

  private async hydrate(agentSessionId: string): Promise<void> {
    const api = this.apiByAgent.get(agentSessionId)
    const serverId = this.serverIdByAgent.get(agentSessionId)
    if (!api || !serverId) return
    const generation = this.hydrationGeneration.get(agentSessionId) ?? 0
    const meta = stampSessionMeta(
      await api.getSessionInfo(agentSessionId).catch(() => null),
      serverConnections.resolveId(serverId),
    )
    if (
      !meta ||
      !this.consumers.has(agentSessionId) ||
      this.apiByAgent.get(agentSessionId) !== api ||
      this.hydrationGeneration.get(agentSessionId) !== generation
    ) return
    this.metas.set(agentSessionId, meta)
    // The push feed wins for liveness; indexed status only seeds the gap.
    if (meta.status && !this.statuses.has(agentSessionId)) this.statuses.set(agentSessionId, meta.status)
  }

  statusFor(agentSessionId: string): SessionStatus | null {
    return this.statuses.get(agentSessionId) ?? null
  }

  metaFor(agentSessionId: string): SessionMeta | undefined {
    return this.metas.get(agentSessionId)
  }

  trackedCount(): number {
    return this.consumers.size
  }
}

export const agentConversationStatus = new AgentConversationStatusStore()
export { AgentConversationStatusStore }
