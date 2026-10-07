// The pull requests a session works on (docs/plans/session-pull-requests.md).
// A session owns its links; a task reads the links of its sessions.

import type { TaskPrSnapshot } from './task-types'
import type { Attribution } from './user'

/**
 * Who made a session ↔ pull request link.
 *
 * - `branch`: PR sync found the pull request on the branch of the session's
 *   own worktree.
 * - `created`: Solus opened the pull request from this session.
 * - `agent`: the session's agent linked it.
 * - `manual`: a person linked it.
 */
export type SessionPullRequestSource = 'branch' | 'created' | 'agent' | 'manual'

/** One pull request a session works on, with what PR sync last saw. */
export interface SessionPullRequestLink {
  /** The stable Solus session id. */
  sessionId: string
  /** `host/owner/repo`, lower case. */
  repository: string
  number: number
  url: string
  title: string
  source: SessionPullRequestSource
  /** Who linked it. */
  createdBy?: Attribution
  linkedAt: number
  /** What PR sync last saw. Absent until it first answers. */
  snapshot?: TaskPrSnapshot
  /** The code host says that this pull request does not exist. */
  missing?: boolean
  /** The session watches this pull request and its agent wakes on news
   *  (docs/plans/pr-watch.md). Absent when it is not watched. */
  watch?: { startedAt: number }
}

/** What a request to watch, or stop watching, a session's pull request did.
 *  Only `started`, `already-watching` and `stopped` leave the request done. */
export type SessionPullRequestWatchOutcome =
  | 'started'
  | 'already-watching'
  | 'stopped'
  | 'not-linked'
  | 'session-settled'
  | 'merged'
  | 'closed'
  | 'missing'

/** A session's links, by stable session id. A session with none has no key. */
export interface SessionPullRequestsBySession {
  [sessionId: string]: SessionPullRequestLink[]
}
