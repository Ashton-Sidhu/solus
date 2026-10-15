import { ANY_ORGANIZATION } from '../admission/principal'
import { sessionIdOfThread } from '../data/sessions/session-lineage'
import { readSessionPullRequestInterests } from '../data/sessions/session-pull-requests'
import { settledSessionIds } from '../data/sessions/session-states'
import { recentWorktreeSessions } from '../data/tasks/host-records'
import type { PrLinkInterest } from '../data/tasks/task-links'
import { taskSessions } from '../data/tasks/task-sessions'
import { unfinishedTaskProjects } from '../data/tasks/task-store'

// The live work PR sync keeps fresh: what one read of interest reads from the
// database (docs/plans/pr-sync.md §3.1).

/** A branch is asked about for a session that was active this recently. A
 *  link, once made, is kept fresh until its session is settled. */
const BRANCH_LOOKUP_MS = 30 * 24 * 60 * 60_000

/** A live session that runs in its own worktree on a branch. */
export interface LiveCheckout {
  projectScope: string
  branch: string
  /** The stable Solus session id. */
  sessionId: string
}

/** The sessions that work under a task that is not finished, and the
 *  isolated checkouts of those sessions. */
export interface LiveTaskSessions {
  checkouts: LiveCheckout[]
  sessionIds: Set<string>
}

export async function liveTaskSessions(): Promise<LiveTaskSessions> {
  const unfinished = await unfinishedTaskProjects(ANY_ORGANIZATION)
  const sessions = await taskSessions(ANY_ORGANIZATION, [...unfinished.keys()])
  const checkouts: LiveCheckout[] = []
  const sessionIds = new Set<string>()
  for (const [taskId, projectKey] of unfinished) {
    for (const attempt of sessions[taskId] ?? []) {
      if (attempt.role === 'referenced') continue
      sessionIds.add(attempt.sessionId)
      if (projectKey && attempt.isolatedCheckout && attempt.branch) {
        checkouts.push({ projectScope: projectKey, branch: attempt.branch, sessionId: attempt.sessionId })
      }
    }
  }
  return { checkouts, sessionIds }
}

/**
 * The branch of each isolated checkout that live work runs in: the sessions of
 * tasks that are not finished, and the sessions active recently that are not
 * settled. A settled session is not live work.
 */
export async function liveCheckouts(now: number, ofLiveTasks: LiveTaskSessions): Promise<LiveCheckout[]> {
  const checkouts = [...ofLiveTasks.checkouts]
  const seen = new Set(checkouts.map((checkout) => `${checkout.sessionId}\0${checkout.branch}`))
  const recent = recentWorktreeSessions(now - BRANCH_LOOKUP_MS)
    .map((indexed) => ({ ...indexed, sessionId: sessionIdOfThread(indexed.sessionId) }))
  const settled = await settledSessionIds(recent.map((indexed) => indexed.sessionId))
  for (const { sessionId, branch, projectScope } of recent) {
    if (settled.has(sessionId) || seen.has(`${sessionId}\0${branch}`)) continue
    seen.add(`${sessionId}\0${branch}`)
    checkouts.push({ projectScope, branch, sessionId })
  }
  return checkouts
}

/**
 * The pull requests sessions link, as PR sync's interest reads them. A link is live
 * work until its session is settled; a task that is not finished keeps the
 * links of its sessions live, because the task reads them.
 */
export async function sessionLinkInterests(ofLiveTask: Set<string>): Promise<PrLinkInterest[]> {
  const links = await readSessionPullRequestInterests(ANY_ORGANIZATION)
  const settled = await settledSessionIds([...new Set(links.map((link) => link.sessionId))])
  return links.map((link) => ({
    projectScope: link.repository,
    number: link.number,
    isActive: ofLiveTask.has(link.sessionId) || !settled.has(link.sessionId),
    state: link.state,
    updatedAt: link.updatedAt,
  }))
}
