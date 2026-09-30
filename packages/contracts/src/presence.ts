/**
 * Presence — who is on a host and in a session right now
 * (docs/plans/multiplayer-presence.md). Memory-only on the host, never in SQLite.
 * The host, never the client, names a participant: the user comes from the
 * admitted principal, so a client cannot claim to be someone else in another
 * person's avatar stack.
 */

import { z } from 'zod'
import type { AgentId, SessionStatus } from './types'
import type { User } from './user'

/** The fixed palette size; `userColorIndex` gives each user a stable index into it. */
export const PRESENCE_COLOR_COUNT = 8

export type PresenceAccess = 'owner' | 'member' | 'guest'

/** One connected client, as every other client sees it. */
export interface PresenceParticipant {
  /** The person, as the host named them from the admitted principal (plans/012 §1). Each client computes the color with `userColorIndex`. */
  user: User
  /** The transport's id for the client: two panes on one renderer are one participant. */
  clientId: string
  deviceLabel: string
  access: PresenceAccess
  joinedAt: number
}

/** What a client is looking at, reported by the client and relayed as a hint. */
export const presenceFocusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  z.object({ kind: z.literal('work'), workId: z.string().min(1) }),
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
  /** The client is typing in the session it has focused; the host clears it a few seconds after the last keystroke. */
  isComposing: boolean
  /** The client is editing the work it has focused, by the same rule as typing. */
  isEditing: boolean
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
  /** The client is typing in this session; the host clears it a few seconds after the last keystroke. */
  isComposing: boolean
}

/** The turn in flight and whose prompt it answers; runs under that author's seat. */
export interface SessionActiveTurn {
  author: User
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

/** `presenceSetEditing`: the person edits a work, reported by the typing rule
 *  (first keystroke after a pause, then at most every `TYPING_REPEAT_MS`). */
export const presenceSetEditingRequestSchema = z.object({
  workId: z.string().min(1),
  isEditing: z.boolean(),
})
export type PresenceSetEditingRequest = z.infer<typeof presenceSetEditingRequestSchema>
