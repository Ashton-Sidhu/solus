import { SvelteMap } from 'svelte/reactivity'
import { z } from 'zod'
import { EMPTY_SESSION_VIEW, settleFor, type SessionState, type SessionView } from '@solus/contracts/session-state'
import type { SessionMeta, SessionRecord, SessionRecordStatus } from '@solus/contracts/types'
import type { ResourceRole } from '@solus/contracts/sharing'
import { serverConnections } from '@solus/client-core/server-connections'
import { connectedRunnerFor } from '@solus/client-core/session-runner'
import { sessionHomeId } from '@solus/client-core/session-home'
import { isSolusApiId } from '@solus/contracts/uplink'
import { keepEqual } from '@solus/client-core/keep-equal'
import { sessionPullRequestsStore } from '../prs/session-pull-requests.store.svelte'
import { rememberRoles } from '../sharing/resource-roles'
import { usesWindowFilter, visibleInWindow } from '@solus/client-core/organization-filter'
import { managedHostIds } from '@solus/client-core/server-registry'
import { newGrants, sessionShareOf, type SessionShare } from './shared-sessions'

/** A session in a person's list, as a row without a conversation draws it. */
export interface ListedSession {
  /** Where the session opens: its machine, or the organization's Solus API
   *  while the machine that ran it is not connected. */
  serverId: string
  /** The session's home, which keeps its list state and its pull requests:
   *  the organization's Solus API for a published organization session, else
   *  the machine. */
  homeServerId: string
  /** The machine that ran this cloud session is not connected: it opens from
   *  the Solus API, read-only (docs/plans/cloud-service-model.md, R8). */
  runnerOffline: boolean
  sessionId: string
  organizationId?: string
  title: string | null
  /** The project the session belongs to, as its host names it. */
  projectPath: string | null
  createdAt: number
  lastActivityAt: number
  /** Whether the agent works, rests, or was cut off, as the home last reported. */
  status: SessionRecordStatus
  branch: string | null
  /** The person the session belongs to (docs/plans/access-model.md §2.2). */
  ownerKey: string
  /** Started in Meta mode: a lead (docs/plans/lead-session.md). */
  isLead?: boolean
  /** The reader's role on the session; absent on a host that is theirs. */
  role?: ResourceRole
  /** What its first history page is read with, so a click can ask for the
   *  page before the session's metadata arrives. */
  opensWith: Pick<SessionMeta, 'provider' | 'projectPath' | 'cwd'>
  /** Set when another person owns the session: it is in Shared with you
   *  (docs/plans/shared-with-you.md). */
  share?: SessionShare
}

/** What this client last knew of a shared session that left the list, for
 *  the notice when it does not open (docs/plans/shared-with-you.md §4.5). */
export interface FormerShare {
  title: string | null
  share: SessionShare
}

/** The shared sessions this person opened, by session id, with the grant that
 *  was current when they opened it. Kept on this device. */
const OPENED_SHARES_KEY = 'solus:opened-shared-sessions'
const OPENED_SHARES_LIMIT = 500
const openedSharesSchema = z.array(z.tuple([z.string(), z.number()]))

function loadOpenedShares(): [string, number][] {
  try {
    const raw = globalThis.localStorage?.getItem(OPENED_SHARES_KEY)
    return raw ? openedSharesSchema.catch([]).parse(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

function saveOpenedShares(opened: Map<string, number>): void {
  try {
    globalThis.localStorage?.setItem(OPENED_SHARES_KEY, JSON.stringify([...opened].slice(-OPENED_SHARES_LIMIT)))
  } catch {
    // A full or blocked store only costs the unread dot.
  }
}

/** Where a session is in this person's list: its shared settle, and their own
 *  archive and snooze (docs/plans/session-archive.md). */
export type SessionListState = SessionState & SessionView

/** One session to settle, snoozed, or archive: the host a row acts through,
 *  and the session's organization and publication when the row knows them. */
export interface SessionListTarget {
  serverId: string
  sessionId: string
  organizationId?: string | null
  publication?: SessionRecord['publication']
}

/** The connections a session's homes are on. */
export interface SessionListHosts {
  /** The connected saved server a cloud record's runner host id names, or null. */
  connectedRunnerFor(runnerHostId: string): string | null
  connectedServerIds(): string[]
  /** A machine provisioned for an organization; any other is personal (plans/031). Absent: every machine is personal. */
  isManagedHost?(serverId: string): boolean
}

const registryHosts: SessionListHosts = {
  connectedRunnerFor: (runnerHostId) => connectedRunnerFor(runnerHostId),
  connectedServerIds: () => serverConnections.connectedServerIds(),
  isManagedHost: (serverId) => managedHostIds().has(serverId),
}

const NO_STATE: SessionListState = { settledAt: null, settledBy: null, archivedAt: null, snoozedUntil: null, snoozeNote: null }

/**
 * This person's session list (docs/plans/session-archive.md): every root
 * session in the list each home keeps for them, with whether its work is
 * finished, and their own settle, archive, and snooze.
 *
 * A change arrives with what it leaves: `session.stateChanged` for the settle
 * by a session's pull requests or task, `session.viewChanged` for this
 * person's view. It is written here,
 * and nothing is read back.
 *
 * Each session has one home. A published organization session's home is its
 * Solus API, which lists it and keeps its state while the machines that run
 * it rotate; it opens on the machine that ran it while that machine is
 * connected (docs/plans/cloud-service-model.md, R1/R8). A machine's own list
 * does not stand for a published organization session while its Solus API is
 * connected. An unpublished one never reaches the Solus API, so its machine
 * keeps it.
 */
export class SessionListStore {
  /** The sessions in this person's list, by stable session id. */
  private listedBySession = new SvelteMap<string, ListedSession>()
  /** The sessions their pull requests or task settled, by stable session id. */
  private statesBySession = new SvelteMap<string, SessionState>()
  /** This person's view of each session they settled, archived, or snoozed. */
  private viewsBySession = new SvelteMap<string, SessionView>()
  private watchedServerIds = new Set<string>()
  /** Per home, the latest grant this client told the reader about. */
  private grantsSeenUntil = new Map<string, number>()
  private shareListeners = new Set<(granted: ListedSession[]) => void>()
  private recordListeners = new Set<(serverId: string, records: readonly SessionRecord[], readStartedAt: number) => void>()
  /** Shared sessions this client knows that are not in the list: archived, or
   *  opened from a link or a notice. An open tab of one is still in Shared with
   *  you (docs/plans/shared-with-you.md §2, rule 1). */
  private formerShares = new SvelteMap<string, FormerShare>()
  private openedShares = new SvelteMap<string, number>(loadOpenedShares())

  constructor(
    private readonly hosts: SessionListHosts = registryHosts,
    /** Shares granted before this time do not toast (`newGrants`). */
    private readonly startedAt = Date.now(),
  ) {}

  /** Read every connected home's list. */
  async load(): Promise<void> {
    await Promise.all(this.hosts.connectedServerIds().map((serverId) => this.loadHost(serverId)))
  }

  /** Read one home's list. A home that fails the read keeps what it answered last time. */
  private async loadHost(serverId: string): Promise<void> {
    this.watchHost(serverId)
    const api = serverConnections.apiFor(serverId)
    const readStartedAt = performance.now()
    const answer = await api.sessionRecordList().catch(() => null)
    if (!answer || serverConnections.apiFor(serverId) !== api) return
    // A published organization session a managed machine lists is its Solus API's to list;
    // one a connected personal machine runs is that machine's (plans/031 rule 1).
    const records = isSolusApiId(serverId)
      ? answer.records.filter((record) => !this.runsOnConnectedPersonalHost(record))
      : answer.records.filter((record) => this.homeOf(serverId, record) === serverId)
    const answered = new Set(records.map((record) => record.sessionId))
    for (const [sessionId, listed] of this.listedBySession) {
      if (listed.homeServerId !== serverId || answered.has(sessionId)) continue
      this.removeListed(listed)
    }
    for (const record of records) this.writeListed(serverId, record)
    this.announceRecords(serverId, records, readStartedAt)
    sessionPullRequestsStore.adopt(serverId, records)
    this.announceNewGrants(serverId, records)
  }

  /** A host connected: read its list, and each Solus API's, whose sessions
   *  open on the machine that ran them while it is connected. A Solus API
   *  that connects takes the published sessions every machine listed, so
   *  every home is read. */
  async loadConnected(serverId: string): Promise<void> {
    if (isSolusApiId(serverId)) return this.load()
    const homes = this.hosts.connectedServerIds().filter((id) => id === serverId || isSolusApiId(id))
    await Promise.all(homes.map((id) => this.loadHost(id)))
  }

  /** Read one session again: a share or a return changed its place in the
   *  list, and nothing else in this home's list. */
  private async loadSession(serverId: string, sessionId: string): Promise<void> {
    const api = serverConnections.apiFor(serverId)
    const readStartedAt = performance.now()
    const record = await api.sessionRecordGet(sessionId).catch(() => undefined)
    if (record === undefined || serverConnections.apiFor(serverId) !== api) return
    // The rows the list answers: root sessions in the reader's list that this home keeps.
    const isListed = !!record && record.listed !== false && !record.parentSessionId
      && (isSolusApiId(serverId) || this.homeOf(serverId, record) === serverId)
    if (record) this.announceRecords(serverId, [record], readStartedAt)
    if (isListed) {
      this.writeListed(serverId, record)
      this.announceNewGrants(serverId, [record])
    } else {
      const listed = this.listedBySession.get(sessionId)
      if (listed?.homeServerId === serverId) this.removeListed(listed)
      const share = record ? sessionShareOf(record) : undefined
      if (record && share) this.formerShares.set(sessionId, { title: record.customTitle ?? record.title ?? record.slug, share })
    }
    sessionPullRequestsStore.adoptSession(serverId, sessionId, isListed ? record : null)
  }

  private removeListed(listed: ListedSession): void {
    this.rememberFormerShare(listed)
    this.listedBySession.delete(listed.sessionId)
    this.statesBySession.delete(listed.sessionId)
    this.viewsBySession.delete(listed.sessionId)
  }

  private writeListed(serverId: string, record: SessionRecord): void {
    const isCloud = isSolusApiId(serverId)
    const runner = isCloud && record.runnerHostId ? this.hosts.connectedRunnerFor(record.runnerHostId) : null
    // The composer and the cards ask "may I drive it" of the host it opens on (access-model.md §2.7).
    rememberRoles(runner ?? serverId, [{ kind: 'session', id: record.sessionId, role: record.role }])
    // Each reconnect reads the list again: an equal row keeps its object, so
    // its sidebar row does not draw again.
    const listed: ListedSession = {
      serverId: runner ?? serverId,
      homeServerId: serverId,
      runnerOffline: isCloud && !runner,
      sessionId: record.sessionId,
      organizationId: record.organizationId,
      title: record.customTitle ?? record.title ?? record.slug,
      // `record.projectPath` is the provider's encoded folder key, not a path.
      projectPath: record.projectRoot ?? record.cwd ?? null,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      status: record.status,
      branch: record.branch,
      ownerKey: record.ownerKey,
      opensWith: { provider: record.provider, projectPath: record.projectPath, cwd: record.cwd ?? '' },
      share: sessionShareOf(record),
    }
    if (record.isLead) listed.isLead = true
    if (record.role) listed.role = record.role
    this.listedBySession.set(record.sessionId, keepEqual(listed, this.listedBySession.get(record.sessionId) ?? listed))
    this.writeState(record.sessionId, record.state)
    this.writeView(record.sessionId, record.view)
  }

  /** Tell the listeners of each direct share this read shows for the first time. */
  private announceNewGrants(serverId: string, records: readonly SessionRecord[]): void {
    const { granted, seenUntil } = newGrants(
      records.flatMap((record) => this.listedBySession.get(record.sessionId) ?? []),
      this.grantsSeenUntil.get(serverId) ?? this.startedAt,
    )
    this.grantsSeenUntil.set(serverId, seenUntil)
    if (granted.length) for (const listener of this.shareListeners) listener(granted)
  }

  /** A shared session leaves the list: keep whose it was for the notice when it does not open. */
  private rememberFormerShare(listed: ListedSession): void {
    if (listed.share) this.formerShares.set(listed.sessionId, { title: listed.title, share: listed.share })
  }

  /** Hear of each record a machine answered, as read, with when the read
   *  began (`performance.now()`): a live event heard after it is newer. A
   *  Solus API's records are its mirror; the machine that runs a session
   *  answers for its live facts. */
  onRecordsRead(listener: (serverId: string, records: readonly SessionRecord[], readStartedAt: number) => void): () => void {
    this.recordListeners.add(listener)
    return () => this.recordListeners.delete(listener)
  }

  private announceRecords(serverId: string, records: readonly SessionRecord[], readStartedAt: number): void {
    if (isSolusApiId(serverId)) return
    for (const listener of this.recordListeners) listener(serverId, records, readStartedAt)
  }

  /** Hear of each direct share a list read shows for the first time. */
  onNewShares(listener: (granted: ListedSession[]) => void): () => void {
    this.shareListeners.add(listener)
    return () => this.shareListeners.delete(listener)
  }

  /** A forgotten host's sessions leave the list. One its Solus API keeps stays,
   *  and is read again so it opens from the Solus API. */
  forgetHost(serverId: string): void {
    const homes = new Set<string>()
    for (const [sessionId, listed] of this.listedBySession) {
      if (listed.homeServerId === serverId) {
        this.listedBySession.delete(sessionId)
        this.statesBySession.delete(sessionId)
        this.viewsBySession.delete(sessionId)
      } else if (listed.serverId === serverId) {
        homes.add(listed.homeServerId)
      }
    }
    for (const home of homes) void this.loadHost(home)
  }

  private homeOf(serverId: string, record: Pick<SessionRecord, 'organizationId' | 'publication'>): string {
    return sessionHomeId(serverId, record, this.hosts)
  }

  /** A Solus API record whose personal runner is connected: the machine lists it and keeps its state. */
  private runsOnConnectedPersonalHost(record: Pick<SessionRecord, 'runnerHostId'>): boolean {
    const runner = record.runnerHostId ? this.hosts.connectedRunnerFor(record.runnerHostId) : null
    return !!runner && !this.hosts.isManagedHost?.(runner)
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
    // A share gives or takes a place in the reader's list (docs/plans/shared-with-you.md §2).
    events.subscribe('share.changed', ({ resource }) => {
      if (resource.kind === 'session') void this.loadSession(serverId, resource.id)
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
   *  is not listed here is read again. */
  private applyView(serverId: string, sessionId: string, view: SessionView | null): void {
    if (!this.isHomeOf(serverId, sessionId)) return
    this.writeView(sessionId, view)
    const listed = this.listedBySession.get(sessionId)
    if (view?.archivedAt != null) {
      if (listed) this.rememberFormerShare(listed)
      this.listedBySession.delete(sessionId)
    } else if (!this.listedBySession.has(sessionId)) void this.loadSession(serverId, sessionId)
  }

  private writeState(sessionId: string, state: SessionState | null | undefined): void {
    if (state?.settledAt != null) this.statesBySession.set(sessionId, keepEqual(state, this.statesBySession.get(sessionId) ?? state))
    else this.statesBySession.delete(sessionId)
  }

  private writeView(sessionId: string, view: SessionView | null | undefined): void {
    if (view && (view.settledAt != null || view.archivedAt !== null || view.snoozedUntil !== null)) this.viewsBySession.set(sessionId, keepEqual(view, this.viewsBySession.get(sessionId) ?? view))
    else this.viewsBySession.delete(sessionId)
  }

  /** Every session in this person's list. */
  listed(sessionId: string): ListedSession | undefined {
    return this.listedBySession.get(sessionId)
  }

  /** What this client knew of a shared session, listed or not any more. */
  shareFacts(sessionId: string): FormerShare | undefined {
    const listed = this.listedBySession.get(sessionId)
    return listed?.share ? { title: listed.title, share: listed.share } : this.formerShares.get(sessionId)
  }

  /** The grant that was current when this person last opened the session. */
  openedGrantAt(sessionId: string): number | undefined {
    return this.openedShares.get(sessionId)
  }

  /** The person opened a session: a shared one stops showing as new. One
   *  that is not in the list is read from its home, so its tab's row knows
   *  whose it is. */
  markOpened(target: SessionListTarget): void {
    const { sessionId } = target
    if (!this.listedBySession.has(sessionId) && !this.formerShares.has(sessionId)) void this.loadSession(this.homeFor(target), sessionId)
    const grantedAt = this.listedBySession.get(sessionId)?.share?.grantedAt
    if (grantedAt == null || this.openedShares.get(sessionId) === grantedAt) return
    this.openedShares.delete(sessionId)
    this.openedShares.set(sessionId, grantedAt)
    saveOpenedShares(this.openedShares)
  }

  get sessions(): ListedSession[] {
    return [...this.listedBySession.values()]
  }

  /** Local sessions, the selected organization's, and every session of a personal
   *  host (plans/031 rule 1), including cached homes. */
  sessionsInOrganization(organizationId: string | null): ListedSession[] {
    const managed = managedHostIds()
    return this.sessions.filter((session) => visibleInWindow(session.organizationId, organizationId, usesWindowFilter(session.homeServerId, managed)))
  }

  /** This person's snoozes, for the clock that wakes their rows. */
  get views(): SessionView[] {
    return [...this.viewsBySession.values()]
  }

  /** A shared session leaves the sidebar only when this person completes it. */
  isCompletedShare(sessionId: string): boolean {
    return !!this.listedBySession.get(sessionId)?.share && this.viewsBySession.get(sessionId)?.settledAt != null
  }

  /** Where one session is in this person's list. Null for an active session. */
  stateFor(sessionId: string): SessionListState | null {
    const state = this.statesBySession.get(sessionId)
    const view = this.viewsBySession.get(sessionId)
    return state || view ? { ...NO_STATE, ...state, ...view, ...settleFor(state, view) } : null
  }

  /** The home that keeps one session's list state. */
  homeFor(target: SessionListTarget): string {
    return this.listedBySession.get(target.sessionId)?.homeServerId
      ?? sessionHomeId(target.serverId, target, this.hosts)
  }

  /** Settle a session in this person's list, or make a settled one active
   *  again. The list changes at once; a refusal from the home puts the
   *  previous state back. */
  async setSettled(target: SessionListTarget, isSettled: boolean): Promise<void> {
    const serverId = this.homeFor(target)
    this.watchHost(serverId)
    const previousState = this.statesBySession.get(target.sessionId)
    const previousView = this.viewsBySession.get(target.sessionId)
    this.writeView(target.sessionId, { ...(previousView ?? EMPTY_SESSION_VIEW), settledAt: isSettled ? Date.now() : null })
    if (!isSettled) this.writeState(target.sessionId, null)
    try {
      const { state, view } = await serverConnections.apiFor(serverId).sessionUpdate(target.sessionId, { settled: isSettled })
      // Only an editor's unsettle ends the shared settle; the answer says when it did.
      this.writeState(target.sessionId, state ?? this.statesBySession.get(target.sessionId) ?? previousState)
      if (view) this.applyView(serverId, target.sessionId, view)
    } catch (error) {
      this.writeState(target.sessionId, previousState)
      this.writeView(target.sessionId, previousView)
      throw error
    }
  }

  /** Snooze a session in this person's list until a wake time; null wakes it now. */
  async snooze(target: SessionListTarget, until: number | null, note = ''): Promise<void> {
    const serverId = this.homeFor(target)
    this.watchHost(serverId)
    const { view } = await serverConnections.apiFor(serverId).sessionUpdate(target.sessionId, { snoozedUntil: until, snoozeNote: note })
    if (view) this.applyView(serverId, target.sessionId, view)
  }

  /** Take a session out of this person's list, or return it. It leaves the
   *  list at once, and comes back when the home refuses. */
  async setArchived(target: SessionListTarget, isArchived: boolean): Promise<void> {
    const serverId = this.homeFor(target)
    this.watchHost(serverId)
    const listed = isArchived ? this.listedBySession.get(target.sessionId) : undefined
    if (listed) {
      this.rememberFormerShare(listed)
      this.listedBySession.delete(target.sessionId)
    }
    try {
      const { view } = await serverConnections.apiFor(serverId).sessionUpdate(target.sessionId, { archived: isArchived })
      this.writeView(target.sessionId, view)
      if (!isArchived && !this.listedBySession.has(target.sessionId)) void this.loadSession(serverId, target.sessionId)
    } catch (error) {
      if (listed && !this.listedBySession.has(target.sessionId)) this.listedBySession.set(target.sessionId, listed)
      throw error
    }
  }
}

export const sessionListStore = new SessionListStore()
