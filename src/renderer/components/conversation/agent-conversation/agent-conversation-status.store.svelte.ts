import { SvelteMap } from 'svelte/reactivity'
import type { SessionMeta, SessionStatus } from '../../../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import type { HostEventSubscriber } from '@client-core/host-event-subscriber'

type SolusApi = typeof window.solus

/**
 * Live status + indexed metadata for agents shown in conversation cards.
 *
 * These agents have no bound tab, so their state can't come from the tab registry —
 * it rides the host's `session.statusChanged` event, with `getSessionInfo`
 * hydration for the slower facts (slug title, model, cwd) and re-hydration when
 * the session index names a tracked agent. An agent lives on whichever server its
 * caller's tab is bound to, so each agent is tracked against that tab's api and
 * the topic subscription is made once per distinct server api.
 */
class AgentConversationStatusStore {
  private statuses = new SvelteMap<string, SessionStatus>()
  private metas = new SvelteMap<string, SessionMeta>()
  private apiByAgent = new Map<string, SolusApi>()
  private consumers = new Map<string, number>()
  private hydrationGeneration = new Map<string, number>()
  private subscribedApis = new WeakSet<object>()

  constructor(
    private readonly eventsForApi: (api: SolusApi) => HostEventSubscriber = (api) => serverConnections.eventsForApi(api),
  ) {}

  private subscribe(api: SolusApi): void {
    if (this.subscribedApis.has(api)) return
    this.subscribedApis.add(api)
    const events = this.eventsForApi(api)
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
  retain(agentSessionId: string, api: SolusApi = window.solus): () => void {
    this.subscribe(api)
    const count = this.consumers.get(agentSessionId) ?? 0
    this.consumers.set(agentSessionId, count + 1)
    if (count === 0) {
      this.apiByAgent.set(agentSessionId, api)
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
      this.statuses.delete(agentSessionId)
      this.metas.delete(agentSessionId)
      this.hydrationGeneration.set(agentSessionId, (this.hydrationGeneration.get(agentSessionId) ?? 0) + 1)
    }
  }

  private async hydrate(agentSessionId: string): Promise<void> {
    const api = this.apiByAgent.get(agentSessionId) ?? window.solus
    const generation = this.hydrationGeneration.get(agentSessionId) ?? 0
    const meta = await api.getSessionInfo(agentSessionId).catch(() => null)
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
