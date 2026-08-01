import { SvelteMap } from 'svelte/reactivity'
import type { SessionMeta, SessionStatus } from '../../../../shared/types'

type SolusApi = typeof window.solus

/**
 * Live status + indexed metadata for agents shown in conversation cards.
 *
 * These agents have no bound tab, so their state can't come from the tab registry —
 * it rides the global `session-status-changed` topic, with `getSessionInfo`
 * hydration for the slower facts (slug title, model, cwd) and re-hydration when
 * the session index names a tracked agent. An agent lives on whichever server its
 * caller's tab is bound to, so each agent is tracked against that tab's api and
 * the topic subscription is made once per distinct server api.
 */
class AgentConversationStatusStore {
  private statuses = new SvelteMap<string, SessionStatus>()
  private metas = new SvelteMap<string, SessionMeta>()
  private apiByAgent = new Map<string, SolusApi>()
  private subscribedApis = new WeakSet<object>()

  private subscribe(api: SolusApi): void {
    if (this.subscribedApis.has(api)) return
    this.subscribedApis.add(api)
    api.onSessionStatusChanged?.((event) => {
      // Only tracked agents, so the maps stay bounded by agents actually shown.
      if (this.apiByAgent.has(event.sessionId)) this.statuses.set(event.sessionId, event.status)
    })
    api.onSessionIndexUpdated?.((event) => {
      for (const sessionId of event.sessionIds ?? []) {
        if (this.apiByAgent.has(sessionId)) void this.hydrate(sessionId)
      }
    })
  }

  /** Idempotent: begin following an agent through the given server api. */
  track(agentSessionId: string, api: SolusApi = window.solus): void {
    this.subscribe(api)
    if (this.apiByAgent.has(agentSessionId)) return
    this.apiByAgent.set(agentSessionId, api)
    void this.hydrate(agentSessionId)
  }

  private async hydrate(agentSessionId: string): Promise<void> {
    const api = this.apiByAgent.get(agentSessionId) ?? window.solus
    const meta = await api.getSessionInfo(agentSessionId).catch(() => null)
    if (!meta) return
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
}

export const agentConversationStatus = new AgentConversationStatusStore()
