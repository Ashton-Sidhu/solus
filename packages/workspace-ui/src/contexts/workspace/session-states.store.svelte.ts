import { SvelteMap } from 'svelte/reactivity'
import type { SessionShelfEntry } from '@solus/contracts/session-state'
import { serverConnections } from '@solus/client-core/server-connections'

/** A settled or snoozed session, and the host that holds it. */
export interface ShelvedSession extends SessionShelfEntry {
  serverId: string
}

/**
 * Where each session is in the list: active, settled, or snoozed
 * (docs/plans/session-pull-requests.md).
 *
 * The host holds the state, so every client shows the same list. This store
 * holds the sessions that are not active; a session with no entry is active.
 */
export class SessionStatesStore {
  /** Settled and snoozed sessions by stable session id. */
  private entriesBySession = new SvelteMap<string, ShelvedSession>()
  private watchedServerIds = new Set<string>()

  /** Read every connected host's settled and snoozed sessions. A host that
   *  fails the read keeps what it answered last time. */
  async load(): Promise<void> {
    await Promise.all(serverConnections.connectedServerIds().map(async (serverId) => {
      this.watchHost(serverId)
      const answer = await serverConnections.apiFor(serverId).sessionShelfList().catch(() => null)
      if (!answer) return
      const answered = new Set(answer.map((entry) => entry.sessionId))
      for (const [sessionId, entry] of this.entriesBySession) {
        if (entry.serverId === serverId && !answered.has(sessionId)) this.entriesBySession.delete(sessionId)
      }
      for (const entry of answer) this.entriesBySession.set(entry.sessionId, { ...entry, serverId })
    }))
  }

  /** Each host announces its own changes, so each is subscribed once. */
  private watchHost(serverId: string): void {
    if (this.watchedServerIds.has(serverId)) return
    this.watchedServerIds.add(serverId)
    serverConnections.eventsFor(serverId).subscribe('session.stateChanged', ({ sessionId }) => {
      void this.refresh(serverId, sessionId)
    })
  }

  private async refresh(serverId: string, sessionId: string): Promise<void> {
    const answer = await serverConnections.apiFor(serverId).sessionShelfList([sessionId]).catch(() => null)
    if (!answer) return
    // The host answers under the stable id, which the caller may not hold.
    if (!answer.length) this.entriesBySession.delete(sessionId)
    for (const entry of answer) this.entriesBySession.set(entry.sessionId, { ...entry, serverId })
  }

  /** Every settled or snoozed session the hosts answered with. */
  get entries(): ShelvedSession[] {
    return [...this.entriesBySession.values()]
  }

  /** The state of one session, which a client can know by several ids. Null
   *  for an active session. */
  stateFor(sessionIds: readonly string[]): ShelvedSession | null {
    for (const sessionId of sessionIds) {
      const entry = this.entriesBySession.get(sessionId)
      if (entry) return entry
    }
    return null
  }

  /** Settle a session, or make a settled one active again. */
  async setSettled(serverId: string, sessionId: string, isSettled: boolean): Promise<void> {
    await serverConnections.apiFor(serverId).sessionSetSettled(sessionId, isSettled)
    await this.refresh(serverId, sessionId)
  }

  /** Snooze a session until a wake time; null wakes it now. */
  async snooze(serverId: string, sessionId: string, until: number | null, note = ''): Promise<void> {
    await serverConnections.apiFor(serverId).sessionSnooze(sessionId, until, note)
    await this.refresh(serverId, sessionId)
  }
}

export const sessionStatesStore = new SessionStatesStore()
