import { SvelteMap } from 'svelte/reactivity'
import type { SessionMeta, SessionStatus } from '../../../../shared/types'

/**
 * Live status + indexed metadata for peer sessions shown in relay cards.
 *
 * Peers have no bound tab, so their state can't come from the tab registry —
 * it rides the global `session-status-changed` topic, with `getSessionInfo`
 * hydration for the slower facts (slug title, model, cwd) and re-hydration when
 * the session index names a tracked peer. Statuses are kept only for tracked
 * peers so the maps stay bounded.
 */
class RelayStatusStore {
  private statuses = new SvelteMap<string, SessionStatus>()
  private metas = new SvelteMap<string, SessionMeta>()
  private tracked = new Set<string>()
  private started = false

  private start(): void {
    if (this.started) return
    this.started = true
    window.solus.onSessionStatusChanged?.((event) => {
      if (this.tracked.has(event.sessionId)) this.statuses.set(event.sessionId, event.status)
    })
    window.solus.onSessionIndexUpdated?.((event) => {
      for (const sessionId of event.sessionIds ?? []) {
        if (this.tracked.has(sessionId)) void this.hydrate(sessionId)
      }
    })
  }

  /** Idempotent: begin following a peer and seed its meta/status once. */
  track(peerSessionId: string): void {
    this.start()
    if (this.tracked.has(peerSessionId)) return
    this.tracked.add(peerSessionId)
    void this.hydrate(peerSessionId)
  }

  private async hydrate(peerSessionId: string): Promise<void> {
    const meta = await window.solus.getSessionInfo(peerSessionId).catch(() => null)
    if (!meta) return
    this.metas.set(peerSessionId, meta)
    // The push feed wins for liveness; indexed status only seeds the gap.
    if (meta.status && !this.statuses.has(peerSessionId)) this.statuses.set(peerSessionId, meta.status)
  }

  statusFor(peerSessionId: string): SessionStatus | null {
    return this.statuses.get(peerSessionId) ?? null
  }

  metaFor(peerSessionId: string): SessionMeta | undefined {
    return this.metas.get(peerSessionId)
  }
}

export const relayStatus = new RelayStatusStore()
