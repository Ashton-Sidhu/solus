import type { AgentActivity } from './agent-activity'
import type { AttentionEntry } from './attention-types'
import type { Codebase } from './codebases'
import type { ProjectEntry, SessionRecord } from './types'

/**
 * The session list of one person on one host, as one snapshot and the changes
 * after it (docs/plans/mobile-session-shell.md). It has the shape of T3 Code's
 * shell: a snapshot with a sequence, the changes after a cursor, a point where
 * the client is synchronized, and a refusal that asks for a new snapshot.
 */

/** One row of the list, with every fact the row shows, as the caller sees it. */
export interface SessionShellRow {
  /** The record as the caller reads it: their view, the session state, its execution, and its pull request links. */
  record: SessionRecord
  /** When the caller pinned the session; null when it is not pinned. */
  pinnedAt: number | null
  /** What waits for the caller in this session; null when nothing waits. */
  attention: AttentionEntry | null
  /** The name of the automation that started the session; null when an automation did not start it or it is gone. */
  automationName: string | null
  /** What the agent does now, while a turn runs; null when it does nothing. */
  agentActivity: AgentActivity | null
}

/**
 * Where a client is in the list of one host. A cursor is valid only for the
 * host process that gave it (`epoch`) and for the caller scope it was given
 * to (`scopeKey`). Any other cursor gets a new snapshot.
 */
export interface SessionShellCursor {
  /** Changes when the host process starts: its change log does not survive a restart. */
  epoch: string
  /** A digest of the caller's person and organization scope. It is not a secret and not an identity. */
  scopeKey: string
  /** The last change the client holds. */
  sequence: number
}

export interface SessionShellSnapshot {
  cursor: SessionShellCursor
  /** The listed sessions, newest activity first, and each pinned session out of the list. No child sessions. */
  rows: SessionShellRow[]
  projects: ProjectEntry[]
  /** Null when this host cannot read codebases. */
  codebases: Codebase[] | null
  /** The host's first index sweep runs: the list is not final. */
  indexing: boolean
}

/** One change after a cursor. The row of a session that the caller can no longer read comes as `row.removed`. */
export type SessionShellChange =
  | { kind: 'row.updated'; row: SessionShellRow }
  | { kind: 'row.removed'; sessionId: string }
  | { kind: 'project.updated'; project: ProjectEntry }
  | { kind: 'project.removed'; path: string }
  | { kind: 'codebases.updated'; codebases: Codebase[] }
  | { kind: 'indexing.changed'; indexing: boolean }

/** Changes that move a client from `fromSequence` to `cursor.sequence`. Each change is the current state of its key, so a client applies them in order. */
export interface SessionShellChanges {
  fromSequence: number
  cursor: SessionShellCursor
  changes: SessionShellChange[]
}

export interface SessionShellOpenRequest {
  /** The cursor of the copy the client holds. Absent for a client with no copy. */
  after?: SessionShellCursor
}

/**
 * The answer to an open. After it the caller is synchronized: the host sends
 * each later change as `sessionShell.changed`, while this connection lasts.
 * `snapshot` comes when the request had no cursor, or the cursor is from
 * another host process or scope, or it is older than the host's change log.
 */
export type SessionShellOpenResult =
  | { kind: 'snapshot'; snapshot: SessionShellSnapshot }
  | ({ kind: 'changes' } & SessionShellChanges)
