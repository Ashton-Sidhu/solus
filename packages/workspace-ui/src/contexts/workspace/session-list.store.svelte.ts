import { SvelteMap } from 'svelte/reactivity'
import type { SessionState, SessionView } from '@solus/contracts/session-state'
import type { SessionRecord } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { loadServers } from '@solus/client-core/server-registry'
import { sessionHomeId } from '@solus/client-core/session-home'
import { isSolusApiId } from '@solus/contracts/uplink'
import { sessionPullRequestsStore } from '../prs/session-pull-requests.store.svelte'
import { rememberRoles } from '../sharing/resource-roles'

/** A session in a person's list, as a row without a conversation draws it. */
export interface ListedSession {
  /** Where the session opens: its machine, or the organization's Solus API
   *  while the machine that ran it is not connected. */
  serverId: string
  /** The session's home, which keeps its list state and its pull requests:
   *  the organization's Solus API for an organization session, else the machine. */
  homeServerId: string
  /** The machine that ran this cloud session is not connected: it opens from
   *  the Solus API, read-only (docs/plans/cloud-service-model.md, R8). */
  runnerOffline: boolean
  sessionId: string
  title: string | null
  /** The project the session belongs to, as its host names it. */
  projectPath: string | null
  createdAt: number
}

/** Where a session is in this person's list: its shared settle, and their own
 *  archive and snooze (docs/plans/session-archive.md). */
export type SessionListState = SessionState & SessionView

/** One session to settle, snoozed, or archive: the host a row acts through,
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
  connectedServerIds(): string[]
}

const registryHosts: SessionListHosts = {
  connectedRunnerFor: (runnerHostId) => {
    const runner = loadServers().find((server) => server.uplink?.hostId === runnerHostId)
    return runner && serverConnections.statusFor(runner.id) === 'connected' ? runner.id : null
  },
  connectedServerIds: () => serverConnections.connectedServerIds(),
}

const NO_STATE: SessionListState = { settledAt: null, settledBy: null, archivedAt: null, snoozedUntil: null, snoozeNote: null }

/**
 * This person's session list (docs/plans/session-archive.md): every root
 * session in the list each home keeps for them, with whether its work is
 * finished, and their own archive and snooze.
 *
 * A change arrives with what it leaves: `session.stateChanged` for the shared
 * settle, `session.viewChanged` for this person's view. It is written here,
 * and nothing is read back.
 *
 * Each session has one home. An organization session's home is its Solus
 * API, which lists it and keeps its state while the machines that run it
 * rotate; it opens on the machine that ran it while that machine is connected
 * (docs/plans/cloud-service-model.md, R1/R8). A machine's own list does not
 * stand for an organization session while its Solus API is connected.
 */
export class SessionListStore {
  /** The sessions in this person's list, by stable session id. */
  private listedBySession = new SvelteMap<string, ListedSession>()
  /** The settled sessions this client knows, by stable session id. */
  private statesBySession = new SvelteMap<string, SessionState>()
  /** This person's view of each session they archived or snoozed. */
  private viewsBySession = new SvelteMap<string, SessionView>()
  private watchedServerIds = new Set<string>()

  constructor(private readonly hosts: SessionListHosts = registryHosts) {}

  /** Read every connected home's list. A home that fails the read keeps what
   *  it answered last time. */
  async load(): Promise<void> {
    await Promise.all(this.hosts.connectedServerIds().map((serverId) => this.loadHost(serverId)))
  }

  private async loadHost(serverId: string): Promise<void> {
    this.watchHost(serverId)
    const api = serverConnections.apiFor(serverId)
    const answer = await api.sessionRecordList().catch(() => null)
    if (!answer || serverConnections.apiFor(serverId) !== api) return
    const isCloud = isSolusApiId(serverId)
    // An organization session a machine lists is its Solus API's to list.
    const records = isCloud ? answer.records : answer.records.filter((record) => this.homeOf(serverId, record) === serverId)
    const answered = new Set(records.map((record) => record.sessionId))
    for (const [sessionId, listed] of this.listedBySession) {
      if (listed.homeServerId !== serverId || answered.has(sessionId)) continue
      this.listedBySession.delete(sessionId)
      this.statesBySession.delete(sessionId)
      this.viewsBySession.delete(sessionId)
    }
    for (const record of records) {
      const runner = isCloud && record.runnerHostId ? this.hosts.connectedRunnerFor(record.runnerHostId) : null
      // The composer and the cards ask "may I drive it" of the host it opens on (access-model.md §2.7).
      rememberRoles(runner ?? serverId, [{ kind: 'session', id: record.sessionId, role: record.role }])
      this.listedBySession.set(record.sessionId, {
        serverId: runner ?? serverId,
        homeServerId: serverId,
        runnerOffline: isCloud && !runner,
        sessionId: record.sessionId,
        title: record.customTitle ?? record.title ?? record.slug,
        projectPath: record.projectRoot ?? record.projectPath,
        createdAt: record.createdAt,
      })
      this.writeState(record.sessionId, record.state)
      this.writeView(record.sessionId, record.view)
    }
    sessionPullRequestsStore.adopt(serverId, records)
  }

  private homeOf(serverId: string, record: Pick<SessionRecord, 'organizationId'>): string {
    return sessionHomeId(serverId, record.organizationId, this.hosts)
  }

  /** Each home announces its own changes, so each is subscribed once. */
  private watchHost(serverId: string): void {
    if (this.watchedServerIds.has(serverId)) return
    this.watchedServerIds.add(serverId)
    const events = serverConnections.eventsFor(serverId)
    events.subscribe('session.stateChanged', ({ sessionId, state }) => this.applyState(serverId, sessionId, state))
    events.subscribe('session.viewChanged', ({ sessionId, view }) => this.applyView(serverId, sessionId, view))
    events.subscribe('session.titleChanged', ({ sessionId, title }) => {
      const listed = this.listedBySession.get(sessionId)
      if (listed && listed.title !== title) this.listedBySession.set(sessionId, { ...listed, title })
    })
  }

  /** Whether `serverId` keeps this session's state: a machine's own state of
   *  an organization session is not its place in the list. */
  private isHomeOf(serverId: string, sessionId: string): boolean {
    const listed = this.listedBySession.get(sessionId)
    return !listed || listed.homeServerId === serverId
  }

  private applyState(serverId: string, sessionId: string, state: SessionState | null): void {
    if (!this.isHomeOf(serverId, sessionId)) return
    this.writeState(sessionId, state)
  }

  /** This person's view changed. A session that came back to their list and
   *  is not listed here is read with its home's list. */
  private applyView(serverId: string, sessionId: string, view: SessionView | null): void {
    if (!this.isHomeOf(serverId, sessionId)) return
    this.writeView(sessionId, view)
    if (view?.archivedAt != null) this.listedBySession.delete(sessionId)
    else if (!this.listedBySession.has(sessionId)) void this.loadHost(serverId)
  }

  private writeState(sessionId: string, state: SessionState | null | undefined): void {
    if (state?.settledAt != null) this.statesBySession.set(sessionId, state)
    else this.statesBySession.delete(sessionId)
  }

  private writeView(sessionId: string, view: SessionView | null | undefined): void {
    if (view && (view.archivedAt !== null || view.snoozedUntil !== null)) this.viewsBySession.set(sessionId, view)
    else this.viewsBySession.delete(sessionId)
  }

  /** Every session in this person's list. */
  get sessions(): ListedSession[] {
    return [...this.listedBySession.values()]
  }

  /** This person's snoozes, for the clock that wakes their rows. */
  get views(): SessionView[] {
    return [...this.viewsBySession.values()]
  }

  /** Where one session is in this person's list. Null for an active session. */
  stateFor(sessionId: string): SessionListState | null {
    const state = this.statesBySession.get(sessionId)
    const view = this.viewsBySession.get(sessionId)
    return state || view ? { ...NO_STATE, ...state, ...view } : null
  }

  /** The home that keeps one session's list state. */
  homeFor(target: SessionListTarget): string {
    return this.listedBySession.get(target.sessionId)?.homeServerId
      ?? sessionHomeId(target.serverId, target.organizationId, this.hosts)
  }

  /** Settle a session for everyone, or make a settled one active again. */
  async setSettled(target: SessionListTarget, isSettled: boolean): Promise<void> {
    const serverId = this.homeFor(target)
    this.watchHost(serverId)
    this.applyState(serverId, target.sessionId, (await serverConnections.apiFor(serverId).sessionUpdate(target.sessionId, { settled: isSettled })).state)
  }

  /** Snooze a session in this person's list until a wake time; null wakes it now. */
  async snooze(target: SessionListTarget, until: number | null, note = ''): Promise<void> {
    const serverId = this.homeFor(target)
    this.watchHost(serverId)
    this.applyView(serverId, target.sessionId, (await serverConnections.apiFor(serverId).sessionUpdate(target.sessionId, { snoozedUntil: until, snoozeNote: note })).view)
  }

  /** Take a session out of this person's list, or return it. It leaves the
   *  list at once, and comes back when the home refuses. */
  async setArchived(target: SessionListTarget, isArchived: boolean): Promise<void> {
    const serverId = this.homeFor(target)
    this.watchHost(serverId)
    const listed = isArchived ? this.listedBySession.get(target.sessionId) : undefined
    if (listed) this.listedBySession.delete(target.sessionId)
    try {
      const { view } = await serverConnections.apiFor(serverId).sessionUpdate(target.sessionId, { archived: isArchived })
      this.writeView(target.sessionId, view)
      if (!isArchived && !this.listedBySession.has(target.sessionId)) void this.loadHost(serverId)
    } catch (error) {
      if (listed && !this.listedBySession.has(target.sessionId)) this.listedBySession.set(target.sessionId, listed)
      throw error
    }
  }
}

export const sessionListStore = new SessionListStore()
