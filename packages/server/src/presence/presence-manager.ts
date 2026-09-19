import type {
  HostParticipant,
  HostPresenceSnapshot,
  PresenceAccess,
  PresenceFocus,
  PresenceParticipant,
  SessionActiveTurn,
  SessionActivity,
  SessionPresenceSnapshot,
  TurnAuthor,
} from '@solus/contracts/presence'
import { PRESENCE_NO_FOCUS } from '@solus/contracts/presence'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { isHostOwner, LOCAL_ORGANIZATION_ID, organizationOf, principalDisplayName, principalOwnerId, type Principal } from '../server/principal'
import type { TurnActor } from '../sessions/turn-ledger'
import { presenceColorIndex } from './presence-color'

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
  /** The session this client currently has a non-empty draft for, if any. */
  composingSessionId: string | null
}

export function presenceAccessFor(principal: Principal): PresenceAccess {
  if (isHostOwner(principal)) return 'owner'
  return principal.kind === 'guest' ? 'guest' : 'member'
}

/** The identity every other client sees for a principal; a system caller has none. */
export function turnAuthorFor(principal: Principal): TurnAuthor | null {
  const userId = principalOwnerId(principal)
  if (!userId) return null
  const author: TurnAuthor = { userId, displayName: principalDisplayName(principal), colorIndex: presenceColorIndex(userId) }
  if (principal.kind === 'org-member' && principal.avatarUrl) author.avatarUrl = principal.avatarUrl
  return author
}

/** The same identity for a run's actor: the name on a bubble, a held prompt, or the room's active turn.
 *  Null for the host's own work (automations, follow-ups, local prompts), which carries no name. */
export function turnAuthorOf(actor: TurnActor | undefined): TurnAuthor | null {
  if (!actor?.displayName) return null
  const author: TurnAuthor = { userId: actor.userId, displayName: actor.displayName, colorIndex: presenceColorIndex(actor.userId) }
  if (actor.avatarUrl) author.avatarUrl = actor.avatarUrl
  return author
}

export interface PresenceManagerOptions {
  /** What a focused session is doing, for the host roster; the control plane answers on a real host. */
  describeSession?: (sessionId: string) => SessionActivity | null | Promise<SessionActivity | null>
  now?: () => number
}

export class PresenceManager {
  private readonly entries = new Map<string, PresenceEntry>()
  private readonly describeSession: (sessionId: string) => SessionActivity | null | Promise<SessionActivity | null>
  private readonly now: () => number

  constructor(options: PresenceManagerOptions = {}) {
    this.describeSession = options.describeSession ?? (() => null)
    this.now = options.now ?? Date.now
  }

  /** A client connected. True when it is new to the host; a reconnect changes nothing. */
  join(clientId: string, principal: Principal, deviceLabel: string): boolean {
    if (this.entries.has(clientId)) return false
    const author = turnAuthorFor(principal)
    if (!author) return false
    const participant: PresenceParticipant = {
      clientId,
      userId: author.userId,
      displayName: author.displayName,
      colorIndex: author.colorIndex,
      deviceLabel,
      access: presenceAccessFor(principal),
      joinedAt: this.now(),
    }
    if (author.avatarUrl) participant.avatarUrl = author.avatarUrl
    this.entries.set(clientId, { participant, organizationId: organizationOf(principal), focus: PRESENCE_NO_FOCUS, composingSessionId: null })
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
   * The sessions whose room changed. A client composes in at most one session:
   * switching drafts moves the mark rather than doubling it, and the previous
   * session is returned too so its room is republished.
   */
  setComposing(clientId: string, sessionId: string, isComposing: boolean): string[] {
    const entry = this.entries.get(clientId)
    if (!entry) return []
    const before = entry.composingSessionId
    const after = isComposing ? sessionId : before === sessionId ? null : before
    if (before === after) return []
    entry.composingSessionId = after
    const changed = new Set<string>()
    if (before) changed.add(before)
    if (after) changed.add(after)
    return [...changed]
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
      }
      const activity = focusedSessionId ? await this.describeSession(focusedSessionId) : null
      if (activity) participant.activity = activity
      participants.push(participant)
    }
    return { participants }
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

function sameFocus(a: PresenceFocus, b: PresenceFocus): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId
  if (a.kind === 'work' && b.kind === 'work') return a.workId === b.workId
  return true
}

/** The active turn as the room reports it: the run's author, or the host itself. */
export function activeTurnFor(actor: TurnActor | undefined, provider: SessionActiveTurn['provider']): SessionActiveTurn {
  const userId = actor?.userId ?? HOST_OWNER_USER_ID
  return {
    authorUserId: userId,
    authorDisplayName: actor?.displayName ?? (userId === HOST_OWNER_USER_ID ? 'Host owner' : userId),
    colorIndex: presenceColorIndex(userId),
    provider,
  }
}
