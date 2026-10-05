import { SvelteMap } from 'svelte/reactivity'
import type { HostPresenceSnapshot, PresenceFocus, SessionPresenceSnapshot, WorkPresenceSnapshot } from '@solus/contracts/presence'
import { PRESENCE_NO_FOCUS } from '@solus/contracts/presence'
import type { UserId } from '@solus/contracts/user'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { followStep, peopleFrom, sameFocus, type FocusReport, type PeopleOptions, type PresencePerson } from '../../components/presence/lib/presence-people'
import { hostPeopleAcrossHosts, rosterPeople, type RosterPerson } from '../../components/presence/lib/host-people'
import { sharesStore } from '../sharing/shares.store.svelte'
import { roleCanDrive } from '../sharing/session-drive'
import { toasts } from '../../lib/toasts'
import { notificationsStore } from '../notifications/notifications.store.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { visibleRef } from '../workspace/routing/location'
import { TypingReporter } from './typing-reporter'

/**
 * Who is here, per host (docs/plans/multiplayer-presence.md). The host owns the
 * rooms and names every participant; this store keeps the last snapshot it was
 * sent, tells the host what this client is looking at and whether it is typing,
 * and answers every surface's "who else" from one place, so a stack in the band,
 * a dot in the sidebar, and a name on a bubble can never disagree. It also owns
 * follow mode. Host and organization arrivals update presence without a notice.
 */

/** How long a focus change waits before it is sent, so a tab sweep is one report. */
const FOCUS_REPORT_DELAY_MS = 400
/** The one toast slot follow mode holds while it is on. */
const FOLLOW_TOAST_ID = 'presence-follow'

/** The person this client is following, and where. */
export interface FollowTarget {
  serverId: string
  userId: string
  displayName: string
}

/** The workspace surface presence reads: the focused pane and the hosts behind it. */
type PresenceWorkspace = Pick<WorkspaceContext, 'router' | 'focusedChatTabId' | 'sessionFor' | 'serverIdFor' | 'openRoute' | 'worksStore'>

function sessionKey(serverId: string, sessionId: string): string {
  return `${serverId}|${sessionId}`
}

/** What the focused pane shows, as the host is told it. */
function workspaceFocus(workspace: Omit<PresenceWorkspace, 'openRoute'>): FocusReport {
  const ref = visibleRef(workspace.router.focused)
  if (ref?.name === 'chat') {
    const tabId = workspace.focusedChatTabId
    const current = tabId ? workspace.sessionFor(tabId) : undefined
    if (tabId && current?.id) return { serverId: workspace.serverIdFor(tabId), focus: { kind: 'session', sessionId: current.id } }
  }
  if (ref?.name === 'work') {
    const serverId = workspace.worksStore.hostFor(ref.params.workId) ?? ref.params.serverId ?? null
    if (serverId) return { serverId, focus: { kind: 'work', workId: ref.params.workId } }
  }
  return { serverId: null, focus: PRESENCE_NO_FOCUS }
}

class PresenceStore {
  /** serverId → everyone connected there, as the host last said. */
  readonly hosts = new SvelteMap<string, HostPresenceSnapshot>()
  /** serverId → this client's id there, so it can leave itself out of a stack. */
  readonly selfClientIds = new SvelteMap<string, string>()
  /** `serverId|sessionId` → that session's room. */
  readonly sessions = new SvelteMap<string, SessionPresenceSnapshot>()
  /** `serverId|workId` → that work's people, sent to a guest on its link instead of the host room. */
  readonly works = new SvelteMap<string, WorkPresenceSnapshot>()
  /** The person this client goes along with, or null. */
  following = $state<FollowTarget | null>(null)
  private readonly loads = new Map<string, Promise<void>>()
  private readonly lastFocus = new Map<string, PresenceFocus>()
  private focusTimer: ReturnType<typeof setTimeout> | null = null
  private pendingFocus: FocusReport | null = null
  /** `serverId|sessionId` → the room a typing report goes to. */
  private readonly typingRooms = new Map<string, { serverId: string; sessionId: string }>()
  private readonly typing = new TypingReporter((key, isComposing) => {
    const room = this.typingRooms.get(key)
    if (!room) return
    if (!isComposing) this.typingRooms.delete(key)
    serverConnections.apiFor(room.serverId).presenceSetComposing({ sessionId: room.sessionId, isComposing }).catch(() => {})
  })
  /** `serverId|workId` → the work an editing report goes to. */
  private readonly editingRooms = new Map<string, { serverId: string; workId: string }>()
  private readonly editing = new TypingReporter((key, isEditing) => {
    const room = this.editingRooms.get(key)
    if (!room) return
    if (!isEditing) this.editingRooms.delete(key)
    serverConnections.apiFor(room.serverId).presenceSetEditing({ workId: room.workId, isEditing }).catch(() => {})
  })
  private stopListening: (() => void) | null = null
  /** The focus follow mode last opened, so a person's move is followed once. */
  private lastFollowed: PresenceFocus | null = null

  /** Called once at boot: rooms arrive as snapshots; a reconnect re-reads and re-reports. */
  listen(): () => void {
    if (this.stopListening) return this.stopListening
    const unsubscribeHost = subscribeAllHosts('host.presenceChanged', (serverId, snapshot) => {
      this.hosts.set(serverId, snapshot)
      void this.ensure(serverId)
    })
    const unsubscribeSession = subscribeAllHosts('session.presenceChanged', (serverId, snapshot) => {
      this.sessions.set(sessionKey(serverId, snapshot.sessionId), snapshot)
    })
    const unsubscribeWork = subscribeAllHosts('work.presenceChanged', (serverId, snapshot) => {
      this.works.set(sessionKey(serverId, snapshot.workId), snapshot)
    })
    const unsubscribeStatus = serverConnections.onStatusChange((serverId, status) => {
      if (status !== 'connected') return
      // The host may have restarted and forgotten this client: read the room
      // again and say again what is on screen.
      this.selfClientIds.delete(serverId)
      void this.ensure(serverId).then(() => {
        const focus = this.lastFocus.get(serverId)
        if (focus && focus.kind !== 'none') void this.send(serverId, focus)
      })
    })
    for (const serverId of serverConnections.connectedServerIds()) void this.ensure(serverId)
    this.stopListening = () => {
      unsubscribeHost()
      unsubscribeSession()
      unsubscribeWork()
      unsubscribeStatus()
      if (this.focusTimer) clearTimeout(this.focusTimer)
      this.typing.clear()
      this.typingRooms.clear()
      this.editing.clear()
      this.editingRooms.clear()
      this.stopListening = null
    }
    return this.stopListening
  }

  /** Read the host room once per connection, and learn which participant this client is. */
  async ensure(serverId: string): Promise<void> {
    if (this.selfClientIds.has(serverId)) return
    const inFlight = this.loads.get(serverId)
    if (inFlight) return inFlight
    // Who this client is to the host, before the room arrives.
    void sharesStore.identityFor(serverId).catch(() => {})
    const load = serverConnections.apiFor(serverId).presenceSnapshot()
      .then((result) => {
        this.selfClientIds.set(serverId, result.clientId)
        this.hosts.set(serverId, result.host)
      })
      .catch(() => {
        // An older host, or a connection that dropped mid-read: the stacks stay empty.
      })
      .finally(() => { this.loads.delete(serverId) })
    this.loads.set(serverId, load)
    return load
  }

  /**
   * Who the reader is on a host: the one user the host named this client as
   * (plans/012 §1). "Is this me?" is `sameUser` against it. The room's own row
   * is read first because it is fresh on every snapshot; the connection's
   * identity answers before the room arrives. Null until the host has said, and
   * then nothing reads as the reader's own.
   */
  currentUserId(serverId: string): UserId | null {
    const clientId = this.selfClientIds.get(serverId)
    const own = clientId ? this.hosts.get(serverId)?.participants.find((participant) => participant.clientId === clientId) : undefined
    return own?.user.id ?? sharesStore.identities.get(serverId)?.user?.id ?? null
  }

  /** How a host's participants are read: who the reader is there. */
  private peopleOptions(serverId: string): PeopleOptions {
    return { self: this.currentUserId(serverId) }
  }

  /** Everyone else on the host, one per person, with what they have focused. */
  hostPeople(serverId: string): PresencePerson[] {
    const snapshot = this.hosts.get(serverId)
    if (!snapshot) return []
    return peopleFrom(snapshot.participants, this.peopleOptions(serverId))
  }

  /** Everyone else in a session's room; empty until the host has sent the room. */
  sessionPeople(serverId: string, sessionId: string): PresencePerson[] {
    const snapshot = this.sessions.get(sessionKey(serverId, sessionId))
    if (!snapshot) return []
    return peopleFrom(snapshot.participants, this.peopleOptions(serverId))
  }

  /** Everyone else across the hosts this client is on, one face per person however many hosts they are on. */
  roster(): RosterPerson[] {
    const rows = hostPeopleAcrossHosts(serverConnections.connectedServerIds(), (serverId) => this.hostPeople(serverId))
    return rosterPeople(rows)
  }

  sessionRoom(serverId: string, sessionId: string): SessionPresenceSnapshot | undefined {
    return this.sessions.get(sessionKey(serverId, sessionId))
  }

  /** The people whose focused pane shows one session or work: from the host room, or a guest's work room. */
  peopleFocusedOn(serverId: string, focus: PresenceFocus): PresencePerson[] {
    const workRoom = focus.kind === 'work' ? this.works.get(sessionKey(serverId, focus.workId)) : undefined
    if (workRoom) return peopleFrom(workRoom.participants, this.peopleOptions(serverId))
    return this.hostPeople(serverId).filter((person) => person.focus && sameFocus(person.focus, focus))
  }

  /**
   * Tell the host what the focused pane shows. Read reactively from the
   * workspace; called from one `$effect` per shell. A change moves the report
   * to the new host and clears it on the old one, so nobody is shown on a
   * session this client left.
   */
  reportWorkspaceFocus(workspace: Omit<PresenceWorkspace, 'openRoute'>): void {
    this.pendingFocus = workspaceFocus(workspace)
    if (this.focusTimer) return
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null
      const pending = this.pendingFocus
      this.pendingFocus = null
      if (pending) this.applyFocus(pending.serverId, pending.focus)
    }, FOCUS_REPORT_DELAY_MS)
  }

  private applyFocus(serverId: string | null, focus: PresenceFocus): void {
    for (const [otherServerId, last] of this.lastFocus) {
      if (otherServerId !== serverId && last.kind !== 'none') void this.send(otherServerId, PRESENCE_NO_FOCUS)
    }
    if (!serverId) return
    const last = this.lastFocus.get(serverId)
    if (last && sameFocus(last, focus)) return
    void this.send(serverId, focus)
  }

  private async send(serverId: string, focus: PresenceFocus): Promise<void> {
    this.lastFocus.set(serverId, focus)
    try {
      await serverConnections.apiFor(serverId).presenceSetFocus({ focus })
    } catch {
      // A host that predates presence, or a dropped connection: nothing to show.
    }
  }

  /** The person pressed a key in a session's prompt; the host hears it at most once per repeat interval. */
  noteTyping(serverId: string | null | undefined, sessionId: string | null | undefined): void {
    // A member who may only read the session is not composing in it; the host refuses the report.
    if (!serverId || !sessionId || !roleCanDrive(sharesStore.listFor(serverId, { kind: 'session', id: sessionId })?.callerRole)) return
    const key = sessionKey(serverId, sessionId)
    this.typingRooms.set(key, { serverId, sessionId })
    this.typing.keystroke(key)
  }

  /** Typing in a session ended on purpose: the prompt went out or was cleared, or the bar left it. */
  stopTyping(serverId: string | null | undefined, sessionId: string | null | undefined): void {
    if (!serverId || !sessionId) return
    this.typing.stop(sessionKey(serverId, sessionId))
  }

  /** The person changed a work's body; the host hears it by the same rule as typing. */
  noteEditing(serverId: string | null | undefined, workId: string | null | undefined): void {
    if (!serverId || !workId) return
    const key = sessionKey(serverId, workId)
    this.editingRooms.set(key, { serverId, workId })
    this.editing.keystroke(key)
  }

  /** Editing a work ended on purpose: the work closed or went out of view. */
  stopEditing(serverId: string | null | undefined, workId: string | null | undefined): void {
    if (!serverId || !workId) return
    this.editing.stop(sessionKey(serverId, workId))
  }

  /** Go where a person goes, until they leave or the reader opens something of their own. */
  follow(target: FollowTarget): void {
    if (this.following) this.stopFollowing()
    this.following = target
    this.lastFollowed = null
    toasts.show({
      id: FOLLOW_TOAST_ID,
      message: `Following ${target.displayName}`,
      description: 'Open anything yourself to stop.',
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Stop', onAction: () => this.stopFollowing() },
      onDismiss: () => this.stopFollowing(),
    })
  }

  isFollowing(serverId: string, userId: string): boolean {
    return this.following?.serverId === serverId && this.following.userId === userId
  }

  stopFollowing(): void {
    if (!this.following) return
    this.following = null
    this.lastFollowed = null
    toasts.dismiss(FOLLOW_TOAST_ID)
  }

  /**
   * Keep up with the followed person. Read reactively from the workspace and
   * the host rooms; called from one `$effect` per shell beside the focus report.
   */
  syncFollow(workspace: PresenceWorkspace): void {
    const target = this.following
    if (!target) return
    const person = this.hostPeople(target.serverId).find((candidate) => candidate.userId === target.userId) ?? null
    const step = followStep({ person, lastOpened: this.lastFollowed, mine: workspaceFocus(workspace), serverId: target.serverId })
    switch (step.kind) {
      case 'open':
        this.lastFollowed = step.focus
        // The click that started the follow is the one these navigations answer to.
        if (step.focus.kind === 'session') {
          workspace.openRoute({ name: 'chat', params: { sessionId: step.focus.sessionId, serverId: target.serverId } }, { via: 'click' })
        } else if (step.focus.kind === 'work') {
          workspace.openRoute({ name: 'work', params: { workId: step.focus.workId, serverId: target.serverId } }, { via: 'click' })
        }
        return
      case 'stop':
        this.stopFollowing()
        if (step.reason === 'left' && notificationsStore.wants('teammate_presence')) toasts.info(`${target.displayName} left`)
        return
      default:
        return
    }
  }
}

export const presenceStore = new PresenceStore()
