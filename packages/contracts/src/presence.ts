/**
 * Presence — who is on a host and in a session right now
 * (docs/plans/multiplayer-presence.md). Memory-only on the host, never in SQLite.
 * The host, never the client, names a participant: display name, avatar, and
 * color come from the admitted principal, so a client cannot claim to be
 * someone else in another person's avatar stack.
 */

import { z } from 'zod'
import type { AgentId, SessionStatus } from './types'

/** The fixed palette size; the host assigns each user a stable index into it. */
export const PRESENCE_COLOR_COUNT = 8

export type PresenceAccess = 'owner' | 'member' | 'guest'

/** One connected client, as every other client sees it. */
export interface PresenceParticipant {
  /** The transport's id for the client: two panes on one renderer are one participant. */
  clientId: string
  /** `host-owner` for the personal host's owner, a user id for a member, `guest:<id>` for a guest. */
  userId: string
  displayName: string
  avatarUrl?: string
  /** 0 … PRESENCE_COLOR_COUNT − 1; the same user gets the same index on every host. */
  colorIndex: number
  deviceLabel: string
  access: PresenceAccess
  joinedAt: number
}

/** What a client is looking at, reported by the client and relayed as a hint. */
export const presenceFocusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  z.object({ kind: z.literal('none') }),
])
export type PresenceFocus = z.infer<typeof presenceFocusSchema>

export const PRESENCE_NO_FOCUS: PresenceFocus = { kind: 'none' }

/** Whether a session's agent works, waits on a person, or rests. */
export type SessionActivityState = 'idle' | 'running' | 'waiting'

/**
 * What a session is doing, as the host knows it: the name, the task it works
 * on, and whether a turn runs or waits on a person. Stamped by the host on the
 * roster row of everyone who has the session focused, so a teammate's row can
 * say "In Fix login, agent running" on a client that never opened that session.
 */
export interface SessionActivity {
  sessionId: string
  title: string | null
  taskId: string | null
  state: SessionActivityState
  activeTurn: SessionActiveTurn | null
}

export interface HostParticipant extends PresenceParticipant {
  focus: PresenceFocus
  /** The client has a non-empty draft in the session it has focused. */
  isComposing: boolean
  /** The focused session, as the host knows it; absent when the focus is not a session. */
  activity?: SessionActivity
}

/** Everyone connected to the host; the source for "who is here" and "jump to". */
export interface HostPresenceSnapshot {
  participants: HostParticipant[]
}

/** `presenceSnapshot`: the host snapshot plus which participant the caller is. */
export interface PresenceSnapshotResult {
  clientId: string
  host: HostPresenceSnapshot
}

export interface SessionParticipant extends PresenceParticipant {
  /** The client has a non-empty draft for this session. */
  isComposing: boolean
}

/** The turn in flight and whose prompt it answers; runs under that author's seat. */
export interface SessionActiveTurn {
  authorUserId: string
  authorDisplayName: string
  colorIndex: number
  provider: AgentId
}

/** Everyone watching one session, plus the active turn's author. */
export interface SessionPresenceSnapshot {
  sessionId: string
  participants: SessionParticipant[]
  activeTurn: SessionActiveTurn | null
}

/**
 * A session's live status as the roster states it. A turn in flight, or one
 * still connecting, is running; a turn parked on a permission or a plan waits
 * on a person; everything else, including a rate-limit pause that waits on
 * time, rests.
 */
export function sessionActivityStateOf(status: SessionStatus | undefined): SessionActivityState {
  if (status === 'running' || status === 'connecting') return 'running'
  if (status === 'awaiting_input' || status === 'awaiting_plan') return 'waiting'
  return 'idle'
}

export const presenceSetFocusRequestSchema = z.object({ focus: presenceFocusSchema })
export type PresenceSetFocusRequest = z.infer<typeof presenceSetFocusRequestSchema>

export const presenceSetComposingRequestSchema = z.object({
  sessionId: z.string().min(1),
  isComposing: z.boolean(),
})
export type PresenceSetComposingRequest = z.infer<typeof presenceSetComposingRequestSchema>

/** Who wrote a prompt, stamped by the host on the transcript echo so every client can label the bubble. */
export interface TurnAuthor {
  userId: string
  displayName: string
  avatarUrl?: string
  colorIndex: number
}
