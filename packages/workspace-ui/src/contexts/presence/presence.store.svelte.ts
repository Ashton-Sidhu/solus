import { SvelteMap } from 'svelte/reactivity'
import type { HostPresenceSnapshot, PresenceFocus, SessionPresenceSnapshot } from '@solus/contracts/presence'
import { PRESENCE_NO_FOCUS } from '@solus/contracts/presence'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { followStep, newArrivals, peopleFrom, sameFocus, type FocusReport, type PeopleOptions, type PresencePerson } from '../../components/presence/lib/presence-people'
import { hostPeopleAcrossHosts, rosterPeople, type HostPerson, type RosterPerson } from '../../components/presence/lib/host-people'
import { accountStore } from '../account/account.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { sharesStore } from '../sharing/shares.store.svelte'
import { toasts } from '../../lib/toasts'
import { notificationsStore } from '../notifications/notifications.store.svelte'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'
import { visibleRef } from '../workspace/routing/location'

/**
 * Who is here, per host (docs/plans/multiplayer-presence.md). The host owns the
 * rooms and names every participant; this store keeps the last snapshot it was
 * sent, tells the host what this client is looking at and whether it is typing,
 * and answers every surface's "who else" from one place, so a stack in the band,
 * a dot in the sidebar, and a name on a bubble can never disagree. It also owns
 * the two reactions to presence that are not a surface: the notice when someone
 * arrives, and follow mode.
 */

/** How long a focus change waits before it is sent, so a tab sweep is one report. */
const FOCUS_REPORT_DELAY_MS = 400
/** How long a draft change waits, so a keystroke burst is one report. */
const COMPOSING_REPORT_DELAY_MS = 300
/** The one toast slot follow mode holds while it is on. */
const FOLLOW_TOAST_ID = 'presence-follow'

/** The person this client is following, and where. */
export interface FollowTarget {
  serverId: string
  userId: string
  displayName: string
}

/** The workspace surface presence reads: the focused pane and the hosts behind it. */
type PresenceWorkspace = Pick<WorkspaceContext, 'router' | 'focusedChatTabId' | 'sessionFor' | 'serverIdFor' | 'openRoute'>

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
  return { serverId: null, focus: PRESENCE_NO_FOCUS }
}

class PresenceStore {
  /** serverId → everyone connected there, as the host last said. */
  readonly hosts = new SvelteMap<string, HostPresenceSnapshot>()
  /** serverId → this client's id there, so it can leave itself out of a stack. */
  readonly selfClientIds = new SvelteMap<string, string>()
  /** `serverId|sessionId` → that session's room. */
  readonly sessions = new SvelteMap<string, SessionPresenceSnapshot>()
  /** The person this client goes along with, or null. */
  following = $state<FollowTarget | null>(null)
  private readonly loads = new Map<string, Promise<void>>()
  private readonly lastFocus = new Map<string, PresenceFocus>()
  private focusTimer: ReturnType<typeof setTimeout> | null = null
  private pendingFocus: FocusReport | null = null
  private readonly composingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastComposing = new Map<string, boolean>()
  private stopListening: (() => void) | null = null
  /** The focus follow mode last opened, so a person's move is followed once. */
  private lastFollowed: PresenceFocus | null = null

  /** Called once at boot: rooms arrive as snapshots; a reconnect re-reads and re-reports. */
  listen(): () => void {
    if (this.stopListening) return this.stopListening
    const unsubscribeHost = subscribeAllHosts('host.presenceChanged', (serverId, snapshot) => {
      const previous = this.hosts.get(serverId)
      this.hosts.set(serverId, snapshot)
      void this.ensure(serverId)
      for (const person of newArrivals(previous, snapshot, this.peopleOptions(serverId))) this.announceArrival(serverId, person)
    })
    const unsubscribeSession = subscribeAllHosts('session.presenceChanged', (serverId, snapshot) => {
      this.sessions.set(sessionKey(serverId, snapshot.sessionId), snapshot)
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
      unsubscribeStatus()
      if (this.focusTimer) clearTimeout(this.focusTimer)
      for (const timer of this.composingTimers.values()) clearTimeout(timer)
      this.stopListening = null
    }
    return this.stopListening
  }

  /** Read the host room once per connection, and learn which participant this client is. */
  async ensure(serverId: string): Promise<void> {
    if (this.selfClientIds.has(serverId)) return
    const inFlight = this.loads.get(serverId)
    if (inFlight) return inFlight
    // Who this client is to the host, by principal: an owner connection is the
    // host owner under whichever id the room names them.
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
   * Every id that is the reader on a host: the participant the host says they
   * are, the account behind their connection, and `host-owner` on a host they
   * own — their own machine, or one they reach as its owner. The same person on a
   * laptop and in a browser is then left out of their own stack on every host,
   * whichever door each client came through.
   */
  selfUserIds(serverId: string): string[] {
    const ids = new Set<string>()
    const clientId = this.selfClientIds.get(serverId)
    const own = clientId ? this.hosts.get(serverId)?.participants.find((participant) => participant.clientId === clientId)?.userId : undefined
    if (own) ids.add(own)
    const identity = sharesStore.identities.get(serverId)
    if (identity?.userId) ids.add(identity.userId)
    if (serverId === LOCAL_SERVER_ID || identity?.principal === 'local-owner' || identity?.principal === 'remote-owner') ids.add(HOST_OWNER_USER_ID)
    const account = accountStore.state
    if (account.kind === 'signed-in') ids.add(account.profile.id)
    return [...ids]
  }

  /** How a host's participants are read: who the reader is there, and what its owner is called. */
  private peopleOptions(serverId: string): PeopleOptions {
    const options: PeopleOptions = { self: this.selfUserIds(serverId) }
    const ownerName = this.hostOwnerName(serverId)
    if (ownerName) options.hostOwnerName = ownerName
    return options
  }

  /** The account name behind a shared personal host's `host-owner`, from the directory row. */
  private hostOwnerName(serverId: string): string | undefined {
    const host = serversStore.hostFor(serverId)
    return host && 'uplink' in host ? host.uplink?.ownerName : undefined
  }

  /**
   * The identity behind a roster row, for merging across hosts: the account id,
   * or for a personal host's `host-owner` the account that linked it — the reader's
   * own on their machine, the directory's answer on a shared one. A host the
   * directory never named keeps its owner apart under the host's own id.
   */
  identityOf(row: HostPerson): string {
    if (row.userId !== HOST_OWNER_USER_ID) return row.userId
    if (row.serverId === LOCAL_SERVER_ID && accountStore.state.kind === 'signed-in') return accountStore.state.profile.id
    const host = serversStore.hostFor(row.serverId)
    const ownerUserId = host && 'uplink' in host ? host.uplink?.ownerUserId : undefined
    return ownerUserId ?? `${HOST_OWNER_USER_ID}@${row.serverId}`
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
    return rosterPeople(rows, (row) => this.identityOf(row))
  }

  sessionRoom(serverId: string, sessionId: string): SessionPresenceSnapshot | undefined {
    return this.sessions.get(sessionKey(serverId, sessionId))
  }

  /** The people whose focused pane shows one session, from the host room. */
  peopleFocusedOn(serverId: string, focus: PresenceFocus): PresencePerson[] {
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

  /** This client has (or no longer has) a draft in a session; sent after a short quiet period. */
  setComposing(serverId: string | null | undefined, sessionId: string | null | undefined, isComposing: boolean): void {
    if (!serverId || !sessionId) return
    const key = sessionKey(serverId, sessionId)
    const timer = this.composingTimers.get(key)
    if (timer) clearTimeout(timer)
    this.composingTimers.set(key, setTimeout(() => {
      this.composingTimers.delete(key)
      if (this.lastComposing.get(key) === isComposing) return
      this.lastComposing.set(key, isComposing)
      serverConnections.apiFor(serverId).presenceSetComposing({ sessionId, isComposing }).catch(() => {})
    }, isComposing ? COMPOSING_REPORT_DELAY_MS : 0))
  }

  /** Someone arrived on a host: one quiet notice, naming the host only when this client is on several. */
  private announceArrival(serverId: string, person: PresencePerson): void {
    if (!notificationsStore.wants('teammate_presence')) return
    const onSeveralHosts = serverConnections.connectedServerIds().length > 1
    const hostLabel = onSeveralHosts ? serversStore.hostFor(serverId)?.label : undefined
    toasts.info(`${person.displayName} joined`, hostLabel ? { description: hostLabel } : undefined)
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
