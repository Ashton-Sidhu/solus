// The pull requests a session works on (docs/plans/session-pull-requests.md).
// A session owns its links; a task reads the links of its sessions.

import { parseGitHubPullRequestUrl } from './providers'
import type { TaskPrSnapshot } from './task-types'
import type { Attribution } from './user'

/** The pull request a URL names, as a link stores it. Null for a URL that is
 *  not a pull request. */
export function pullRequestIdentityOf(url: string): { repository: string; number: number; url: string } | null {
  const parsed = parseGitHubPullRequestUrl(url)
  if (!parsed) return null
  const { host, owner, repo } = parsed.baseRepo
  return { repository: `${host}/${owner}/${repo}`.toLowerCase(), number: parsed.number, url: parsed.url }
}

/**
 * Who made a session ↔ pull request link.
 *
 * - `branch`: PR sync found the pull request on the session's branch. A
 *   session holds one such row, and it follows the branch.
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
