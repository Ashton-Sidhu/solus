import { SvelteMap } from 'svelte/reactivity'
import type { SessionState } from '@solus/contracts/session-state'
import { serverConnections } from '@solus/client-core/server-connections'
import { loadServers } from '@solus/client-core/server-registry'
import { isSolusApiId, solusApiId } from '@solus/contracts/uplink'

/** A session in a host's list, as a row without a conversation draws it. */
export interface ListedSession {
  /** Where the session opens: its machine, or the organization's Solus API
   *  while the machine that ran it is not connected. */
  serverId: string
  /** Where its place in the list is kept and changed: the organization's Solus
   *  API for an organization session, else the machine. */
  stateServerId: string
  /** The connection whose list named the session. */
  listedBy: string
  /** The machine that ran this cloud session is not connected: it opens from
   *  the Solus API, read-only (docs/plans/cloud-service-model.md, R8). */
  runnerOffline: boolean
  sessionId: string
  title: string | null
  /** The project the session belongs to, as its host names it. */
  projectPath: string | null
  createdAt: number
}

/** One session to settle, snooze, or archive: the host a row acts through,
 *  and the session's organization when the row knows it. */
export interface SessionListTarget {
  serverId: string
  sessionId: string
  organizationId?: string | null
}

/** The connections a session's homes are on. */
export interface SessionListHosts {
  /** The connected saved server a cloud record's runner host id names, or null. */
  connectedRunnerFor(runnerHostId: string): string | null
  /** The connected Solus API of an organization, or null. */
  connectedSolusApiFor(organizationId: string): string | null
}

const registryHosts: SessionListHosts = {
  connectedRunnerFor: (runnerHostId) => {
    const runner = loadServers().find((server) => server.uplink?.hostId === runnerHostId)
    return runner && serverConnections.statusFor(runner.id) === 'connected' ? runner.id : null
  },
  connectedSolusApiFor: (organizationId) => {
    const serverId = solusApiId(organizationId)
    return serverConnections.connectedServerIds().includes(serverId) ? serverId : null
  },
}

/** Whether a state puts the session on no shelf and keeps it in the list. */
function isActive(state: SessionState | null | undefined): boolean {
  return !state || (state.settledAt === null && state.snoozedUntil === null && state.archivedAt === null)
}

/**
 * Each host's session list (docs/plans/session-archive.md): every root session
 * that is not archived, with where it is in the list. The host holds the
 * state, so every client shows the same list.
 *
 * A change arrives with the state it leaves (`session.stateChanged`) and is
 * written here; nothing is read back. A session with no state is active.
 *
 * An organization session's place in the list is kept by the organization's
 * Solus API, because the machines that run sessions rotate and go offline.
 * The API lists it, its state is changed there, and it opens on the machine
 * that ran it while that machine is connected (docs/plans/cloud-service-model.md,
 * R1/R8). A machine's own list does not stand for it while the API is connected.
 */
export class SessionListStore {
  /** The sessions in each host's list, by stable session id. */
  private listedBySession = new SvelteMap<string, ListedSession>()
  /** The sessions that are not active, by stable session id: those in the
   *  list, and those this client heard leave it. */
  private statesBySession = new SvelteMap<string, SessionState>()
  private watchedServerIds = new Set<string>()

  constructor(private readonly hosts: SessionListHosts = registryHosts) {}

  /** Read every connected host's list. A host that fails the read keeps what
   *  it answered last time. */
  async load(): Promise<void> {
    await Promise.all(serverConnections.connectedServerIds().map((serverId) => this.loadHost(serverId)))
  }

  private async loadHost(serverId: string): Promise<void> {
    this.watchHost(serverId)
    const api = serverConnections.apiFor(serverId)
    const answer = await api.sessionRecordList({ archived: false, roots: true }).catch(() => null)
    if (!answer || serverConnections.apiFor(serverId) !== api) return
    const isCloud = isSolusApiId(serverId)
    // An organization session a machine lists is the Solus API's to list.
    const records = isCloud ? answer.records : answer.records.filter((record) => !this.solusApiFor(record.organizationId))
    const answered = new Set(records.map((record) => record.sessionId))
    for (const [sessionId, listed] of this.listedBySession) {
      if (listed.listedBy !== serverId || answered.has(sessionId)) continue
      this.listedBySession.delete(sessionId)
      this.statesBySession.delete(sessionId)
    }
    for (const record of records) {
      const runner = isCloud && record.runnerHostId ? this.hosts.connectedRunnerFor(record.runnerHostId) : null
      this.listedBySession.set(record.sessionId, {
        serverId: runner ?? serverId,
        stateServerId: serverId,
        listedBy: serverId,
        runnerOffline: isCloud && !runner,
        sessionId: record.sessionId,
        title: record.customTitle ?? record.title ?? record.slug,
        projectPath: record.projectRoot ?? record.projectPath,
        createdAt: record.createdAt,
      })
      this.writeState(record.sessionId, record.state)
    }
  }

  private solusApiFor(organizationId: string | null | undefined): string | null {
    return organizationId && organizationId !== 'local' ? this.hosts.connectedSolusApiFor(organizationId) : null
  }

  /** The host that keeps a session's place in the list. */
  private stateServerFor(target: SessionListTarget): string {
    return this.listedBySession.get(target.sessionId)?.stateServerId
      ?? this.solusApiFor(target.organizationId)
      ?? target.serverId
  }

  /** Each host announces its own changes, so each is subscribed once. */
  private watchHost(serverId: string): void {
    if (this.watchedServerIds.has(serverId)) return
    this.watchedServerIds.add(serverId)
    const events = serverConnections.eventsFor(serverId)
    events.subscribe('session.stateChanged', ({ sessionId, state }) => this.applyState(serverId, sessionId, state))
    events.subscribe('session.titleChanged', ({ sessionId, title }) => {
      const listed = this.listedBySession.get(sessionId)
      if (listed && listed.title !== title) this.listedBySession.set(sessionId, { ...listed, title })
    })
  }

  /** Write a state the host announced or answered. A session that came back
   *  to the list and is not listed here is read with its host's list. */
  private applyState(serverId: string, sessionId: string, state: SessionState | void): void {
    if (!state) return
    // A machine's own state of an organization session is not its place in the list.
    const listed = this.listedBySession.get(sessionId)
    if (listed && listed.stateServerId !== serverId) return
    this.writeState(sessionId, state)
    if (state.archivedAt !== null) this.listedBySession.delete(sessionId)
    else if (!this.listedBySession.has(sessionId)) void this.loadHost(serverId)
  }

  private writeState(sessionId: string, state: SessionState | null | undefined): void {
    if (isActive(state)) this.statesBySession.delete(sessionId)
    else this.statesBySession.set(sessionId, state!)
  }

  /** Every session in the hosts' lists. */
  get sessions(): ListedSession[] {
    return [...this.listedBySession.values()]
  }

  /** The states of the sessions that are not active. */
  get states(): SessionState[] {
    return [...this.statesBySession.values()]
  }

  /** The state of one session. Null for an active session. */
  stateFor(sessionId: string): SessionState | null {
    return this.statesBySession.get(sessionId) ?? null
  }

  /** Settle a session, or make a settled one active again. */
  async setSettled(target: SessionListTarget, isSettled: boolean): Promise<void> {
    const serverId = this.stateServerFor(target)
    this.watchHost(serverId)
    this.applyState(serverId, target.sessionId, await serverConnections.apiFor(serverId).sessionSetSettled(target.sessionId, isSettled))
  }

  /** Snooze a session until a wake time; null wakes it now. */
  async snooze(target: SessionListTarget, until: number | null, note = ''): Promise<void> {
    const serverId = this.stateServerFor(target)
    this.watchHost(serverId)
    this.applyState(serverId, target.sessionId, await serverConnections.apiFor(serverId).sessionSnooze(target.sessionId, until, note))
  }

  /** Archive a session, or return an archived one to the list. An archived
   *  session leaves the list at once, and comes back when the host refuses. */
  async setArchived(target: SessionListTarget, isArchived: boolean): Promise<void> {
    const serverId = this.stateServerFor(target)
    this.watchHost(serverId)
    const listed = isArchived ? this.listedBySession.get(target.sessionId) : undefined
    if (listed) this.listedBySession.delete(target.sessionId)
    try {
      this.applyState(serverId, target.sessionId, await serverConnections.apiFor(serverId).sessionSetArchived(target.sessionId, isArchived))
    } catch (error) {
      if (listed && !this.listedBySession.has(target.sessionId)) this.listedBySession.set(target.sessionId, listed)
      throw error
    }
  }
}

export const sessionListStore = new SessionListStore()
