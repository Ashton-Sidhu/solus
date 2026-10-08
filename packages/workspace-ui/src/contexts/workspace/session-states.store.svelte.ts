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
  private readonly changes = new Map<string, Promise<void>>()

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
      const key = `${serverId}\0${sessionId}`
      const read = this.refresh(serverId, sessionId).finally(() => {
        if (this.changes.get(key) === read) this.changes.delete(key)
      })
      this.changes.set(key, read)
    })
  }

  private async refresh(serverId: string, sessionId: string): Promise<void> {
    const api = serverConnections.apiFor(serverId)
    const answer = await api.sessionShelfList([sessionId]).catch(() => null)
    if (!answer || serverConnections.apiFor(serverId) !== api) return
    // The host answers under the stable id, which the caller may not hold.
    if (!answer.length) this.entriesBySession.delete(sessionId)
    for (const entry of answer) this.entriesBySession.set(entry.sessionId, { ...entry, serverId })
  }

  /** Every settled or snoozed session the hosts answered with. */
  get entries(): ShelvedSession[] {
    return [...this.entriesBySession.values()]
  }

  /** The state of one session. Null for an active session. */
  stateFor(sessionId: string): ShelvedSession | null {
    return this.entriesBySession.get(sessionId) ?? null
  }

  /** Settle a session, or make a settled one active again. */
  async setSettled(serverId: string, sessionId: string, isSettled: boolean): Promise<void> {
    this.watchHost(serverId)
    await serverConnections.apiFor(serverId).sessionSetSettled(sessionId, isSettled)
    await this.changes.get(`${serverId}\0${sessionId}`)
  }

  /** Snooze a session until a wake time; null wakes it now. */
  async snooze(serverId: string, sessionId: string, until: number | null, note = ''): Promise<void> {
    this.watchHost(serverId)
    await serverConnections.apiFor(serverId).sessionSnooze(sessionId, until, note)
    await this.changes.get(`${serverId}\0${sessionId}`)
  }
}

export const sessionStatesStore = new SessionStatesStore()
