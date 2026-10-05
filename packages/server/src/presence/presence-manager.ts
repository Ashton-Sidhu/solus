import type {
  HostParticipant,
  HostPresenceSnapshot,
  PresenceAccess,
  PresenceFocus,
  PresenceParticipant,
  SessionActiveTurn,
  SessionActivity,
  SessionPresenceSnapshot,
  WorkPresenceSnapshot,
} from '@solus/contracts/presence'
import { PRESENCE_NO_FOCUS } from '@solus/contracts/presence'
import { isHostOwner, LOCAL_ORGANIZATION_ID, type Principal } from '../admission/principal'
import { actorFor, type Actor } from '../admission/actor'
import { hostUser } from '../host/host-user'

/**
 * The host room a connected client is in (docs/plans/multiplayer-presence.md):
 * the whole machine on a personal or managed host, where everyone admitted is
 * one room; one organization's room on the Solus API, which serves them all.
 */
export function presenceRoomOf(principal: Principal): string {
  if (principal.kind === 'org-member' && principal.hostKind === 'cloud') return principal.organizationId
  if (principal.kind === 'guest') return principal.organizationId ?? LOCAL_ORGANIZATION_ID
  if (principal.kind === 'runner') return principal.organizationId
  return LOCAL_ORGANIZATION_ID
}

/**
 * Who is connected to this host right now (docs/plans/multiplayer-presence.md).
 * Keyed by the transport's client id: two panes on one renderer are one
 * participant, and a socket that reconnects within the transport's grace period
 * keeps its entry. Nothing here touches SQLite; an entry lives as long as its
 * socket does. Session rooms are not stored: a session's participants are the
 * connected clients among the control plane's watchers for it, so the two can
 * never disagree about who is there. The host room is one organization's
 * (cloud-service-model.md §15): on a host everyone is `local`; on the workspace
 * service each organization sees its own people and never another's.
 */

interface PresenceEntry {
  participant: PresenceParticipant
  /** The organization whose room this client is in. */
  organizationId: string
  focus: PresenceFocus
  /** The session this client is typing in, if any. */
  composingSessionId: string | null
  /** Clears the typing mark when the client's reports stop. */
  cancelComposingExpiry: (() => void) | null
  /** The work this client is editing, if any; the same expiry rule as typing. */
  editingWorkId: string | null
  cancelEditingExpiry: (() => void) | null
  /** The work a guest's link opens; it sees that work's people instead of the host room. */
  guestWorkId: string | null
}

/**
 * How long a typing mark lasts after the client's last report. A client
 * repeats the report while its person types (every 3 s, `TYPING_REPEAT_MS`), so
 * the mark stays up through a burst and falls a few seconds after it ends.
 */
export const TYPING_EXPIRY_MS = 5_000

type Schedule = (run: () => void, delayMs: number) => () => void

const scheduleTimeout: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

export function presenceAccessFor(principal: Principal): PresenceAccess {
  if (isHostOwner(principal)) return 'owner'
  return principal.kind === 'guest' ? 'guest' : 'member'
}

export interface PresenceManagerOptions {
  /** What a focused session is doing, for the host roster; the control plane answers on a real host. */
  describeSession?: (sessionId: string) => SessionActivity | null | Promise<SessionActivity | null>
  now?: () => number
  /** Runs the typing expiry; a test passes a clock it controls. */
  schedule?: Schedule
}

export class PresenceManager {
  private readonly entries = new Map<string, PresenceEntry>()
  private readonly describeSession: (sessionId: string) => SessionActivity | null | Promise<SessionActivity | null>
  private readonly now: () => number
  private readonly schedule: Schedule
  private composingExpired: ((clientId: string, sessionId: string) => void) | null = null
  private editingExpired: ((clientId: string) => void) | null = null

  constructor(options: PresenceManagerOptions = {}) {
    this.describeSession = options.describeSession ?? (() => null)
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? scheduleTimeout
  }

  /** Called when a typing mark falls because its client stopped reporting, so its rooms can be told. */
  onComposingExpired(listener: (clientId: string, sessionId: string) => void): void {
    this.composingExpired = listener
  }

  /** Called when an editing mark falls because its client stopped reporting. */
  onEditingExpired(listener: (clientId: string) => void): void {
    this.editingExpired = listener
  }

  /** A client connected. True when it is new to the host; a reconnect changes nothing. */
  join(clientId: string, principal: Principal, deviceLabel: string): boolean {
    if (this.entries.has(clientId)) return false
    const user = actorFor(principal).user
    if (!user) return false
    const participant: PresenceParticipant = { user, clientId, deviceLabel, access: presenceAccessFor(principal), joinedAt: this.now() }
    this.entries.set(clientId, { participant, organizationId: presenceRoomOf(principal), focus: PRESENCE_NO_FOCUS, composingSessionId: null, cancelComposingExpiry: null, editingWorkId: null, cancelEditingExpiry: null, guestWorkId: guestWorkOf(principal) })
    return true
  }

  /** The organization a connected client's room belongs to; undefined for a client not on the host. */
  organizationOf(clientId: string): string | undefined {
    return this.entries.get(clientId)?.organizationId
  }

  /** Every organization with someone in its room. */
  organizations(): string[] {
    const ids = new Set<string>()
    for (const entry of this.entries.values()) ids.add(entry.organizationId)
    return [...ids]
  }

  /** The connected clients in one organization's room. */
  clientsIn(organizationId: string): string[] {
    const clientIds: string[] = []
    for (const [clientId, entry] of this.entries) if (entry.organizationId === organizationId) clientIds.push(clientId)
    return clientIds
  }

  /** A client's last socket closed. Returns the session it was composing in, so that room can be told. */
  leave(clientId: string): { composingSessionId: string | null } | null {
    const entry = this.entries.get(clientId)
    if (!entry) return null
    entry.cancelComposingExpiry?.()
    entry.cancelEditingExpiry?.()
    this.entries.delete(clientId)
    return { composingSessionId: entry.composingSessionId }
  }

  has(clientId: string): boolean {
    return this.entries.has(clientId)
  }

  /** What a client has focused; undefined for a client not on the host. */
  focusOf(clientId: string): PresenceFocus | undefined {
    return this.entries.get(clientId)?.focus
  }

  /** True when the focus changed, so the host snapshot is worth republishing. */
  setFocus(clientId: string, focus: PresenceFocus): boolean {
    const entry = this.entries.get(clientId)
    if (!entry || sameFocus(entry.focus, focus)) return false
    entry.focus = focus
    return true
  }

  /**
   * The sessions whose room changed. A client types in at most one session:
   * moving to another session moves the mark rather than doubling it, and the
   * previous session is returned too so its room is republished. Each report of
   * typing restarts the expiry; a repeat changes no room.
   */
  setComposing(clientId: string, sessionId: string, isComposing: boolean): string[] {
    const entry = this.entries.get(clientId)
    if (!entry) return []
    const before = entry.composingSessionId
    const after = isComposing ? sessionId : before === sessionId ? null : before
    if (isComposing) {
      entry.cancelComposingExpiry?.()
      entry.cancelComposingExpiry = this.schedule(() => this.expireComposing(clientId, sessionId), TYPING_EXPIRY_MS)
    } else if (after === null) {
      entry.cancelComposingExpiry?.()
      entry.cancelComposingExpiry = null
    }
    if (before === after) return []
    entry.composingSessionId = after
    const changed = new Set<string>()
    if (before) changed.add(before)
    if (after) changed.add(after)
    return [...changed]
  }

  /**
   * Whether a client edits a work, for the gallery and the roster. Each report
   * restarts the expiry, so the mark falls `TYPING_EXPIRY_MS` after the last
   * one. True when the mark changed.
   */
  setEditing(clientId: string, workId: string, isEditing: boolean): boolean {
    const entry = this.entries.get(clientId)
    if (!entry) return false
    const before = entry.editingWorkId
    entry.cancelEditingExpiry?.()
    entry.cancelEditingExpiry = null
    if (isEditing) {
      entry.editingWorkId = workId
      entry.cancelEditingExpiry = this.schedule(() => this.expireEditing(clientId, workId), TYPING_EXPIRY_MS)
    } else if (before === workId) {
      entry.editingWorkId = null
    }
    return before !== entry.editingWorkId
  }

  private expireEditing(clientId: string, workId: string): void {
    const entry = this.entries.get(clientId)
    if (!entry || entry.editingWorkId !== workId) return
    entry.editingWorkId = null
    entry.cancelEditingExpiry = null
    this.editingExpired?.(clientId)
  }

  private expireComposing(clientId: string, sessionId: string): void {
    const entry = this.entries.get(clientId)
    if (!entry || entry.composingSessionId !== sessionId) return
    entry.composingSessionId = null
    entry.cancelComposingExpiry = null
    this.composingExpired?.(clientId, sessionId)
  }

  /**
   * Everyone in one organization's room, each with what they have focused. A
   * session focus is described by the host itself, so a reader who never opened
   * that session still learns its name and whether its agent runs.
   */
  async hostSnapshot(organizationId: string = LOCAL_ORGANIZATION_ID): Promise<HostPresenceSnapshot> {
    const participants: HostParticipant[] = []
    for (const entry of this.entries.values()) {
      if (entry.organizationId !== organizationId) continue
      const focusedSessionId = entry.focus.kind === 'session' ? entry.focus.sessionId : null
      const participant: HostParticipant = {
        ...entry.participant,
        focus: entry.focus,
        isComposing: focusedSessionId !== null && entry.composingSessionId === focusedSessionId,
        isEditing: entry.focus.kind === 'work' && entry.editingWorkId === entry.focus.workId,
      }
      const activity = focusedSessionId ? await this.describeSession(focusedSessionId) : null
      if (activity) participant.activity = activity
      participants.push(participant)
    }
    return { participants }
  }

  /** The guests in one organization's room whose link is a work, by that work. */
  workGuestsIn(organizationId: string): Map<string, string[]> {
    const guests = new Map<string, string[]>()
    for (const [clientId, entry] of this.entries) {
      if (entry.organizationId !== organizationId || !entry.guestWorkId) continue
      guests.set(entry.guestWorkId, [...guests.get(entry.guestWorkId) ?? [], clientId])
    }
    return guests
  }

  /** True when any connected client has the session focused, so a change to it is worth a host republish. */
  isSessionFocused(sessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.focus.kind === 'session' && entry.focus.sessionId === sessionId) return true
    }
    return false
  }

  /**
   * The room of one session: the watchers that are connected. A watcher whose
   * socket dropped is still a watcher to the control plane (its stream may be
   * recovered), but it is not in the room until it is back.
   */
  sessionSnapshot(sessionId: string, watcherClientIds: readonly string[], activeTurn: SessionActiveTurn | null): SessionPresenceSnapshot {
    const participants = []
    for (const clientId of watcherClientIds) {
      const entry = this.entries.get(clientId)
      if (!entry) continue
      participants.push({ ...entry.participant, isComposing: entry.composingSessionId === sessionId })
    }
    return { sessionId, participants, activeTurn }
  }
}

function guestWorkOf(principal: Principal): string | null {
  return principal.kind === 'guest' && principal.share.resource.kind === 'work' ? principal.share.resource.id : null
}

/** The people in a host room who have one work open: the room a guest on that work's link sees. */
export function workPresence(host: HostPresenceSnapshot, workId: string): WorkPresenceSnapshot {
  return { workId, participants: host.participants.filter((participant) => participant.focus.kind === 'work' && participant.focus.workId === workId) }
}

function sameFocus(a: PresenceFocus, b: PresenceFocus): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId
  if (a.kind === 'work' && b.kind === 'work') return a.workId === b.workId
  return true
}

/** The active turn as the room reports it: the run's author, or the host's user for the host's own work. */
export function activeTurnFor(actor: Actor | undefined, provider: SessionActiveTurn['provider']): SessionActiveTurn | null {
  const author = actor?.user ?? hostUser()
  return author ? { author, provider } : null
}
