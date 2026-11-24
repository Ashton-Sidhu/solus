import { SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'
import { ANY_ORGANIZATION } from '../admission/principal'
import { sessionIdOfThread } from '../data/sessions/session-lineage'
import { readSessionPullRequestInterests } from '../data/sessions/session-pull-requests'
import { settledSessionIds } from '../data/sessions/session-states'
import { recentBranchSessions } from '../data/tasks/host-records'
import type { PrLinkInterest } from '../data/tasks/task-links'
import { taskSessions } from '../data/tasks/task-sessions'
import { finishedTaskIds } from '../data/tasks/task-store'
import { projectRootOfPath } from '../git/task-folder-store'
import { hasSessionTurnChanges } from '../git/session-snapshots'

// The live work PR sync keeps fresh: what one read of interest reads from the
// database (docs/plans/pr-sync.md §3.1).

/** A live session on a branch, in its own worktree or on the shared checkout. */
export interface LiveCheckout {
  projectScope: string
  branch: string
  /** The stable Solus session id. */
  sessionId: string
}

/** The sessions that work under a task that is not finished, and the
 *  branches those sessions are on. */
export interface LiveTaskSessions {
  checkouts: LiveCheckout[]
  sessionIds: Set<string>
}

export async function liveTaskSessions(): Promise<LiveTaskSessions> {
  // A task has no project of its own: the project of a session is its checkout.
  const sessions = await taskSessions(ANY_ORGANIZATION)
  const finished = await finishedTaskIds(Object.keys(sessions))
  const checkouts: LiveCheckout[] = []
  const sessionIds = new Set<string>()
  for (const [taskId, attempts] of Object.entries(sessions)) {
    if (finished.has(taskId)) continue
    for (const attempt of attempts) {
      if (attempt.role === 'referenced') continue
      sessionIds.add(attempt.sessionId)
      // A checkout on another host is not this host's to read.
      if (attempt.checkoutPath && attempt.branch && !attempt.executionServerId) {
        checkouts.push({ projectScope: projectRootOfPath(attempt.checkoutPath), branch: attempt.branch, sessionId: attempt.sessionId })
      }
    }
  }
  return { checkouts, sessionIds }
}

/** A `git` session folder, as the host knows it now (docs/plans/codebases.md §8). */
export interface SessionFolderCheckout {
  sessionId: string
  /** Where the session works: the repository itself, or its worktree. */
  path: string
  /** The repository `path` is a checkout of. */
  repositoryPath: string
  /** Null when the checkout is detached, or not read yet. */
  branch: string | null
}

/** The repositories a turn of the session changed. A change is never taken back, so a found one is not read again. */
const changedRepositories = new Set<string>()

function sessionChangedRepository(sessionId: string, repositoryPath: string): boolean {
  const key = `${sessionId}\0${repositoryPath}`
  if (changedRepositories.has(key)) return true
  if (!hasSessionTurnChanges(repositoryPath, sessionId)) return false
  changedRepositories.add(key)
  return true
}

/**
 * The session folders whose branch can name a pull request of the session: a
 * folder that the session's turns changed, and a worktree that a task folder
 * made for the session. A codebase can cover many repositories; one that the
 * session only reads is never looked up on the code host.
 */
export function sessionFolderCheckouts(
  folders: readonly SessionFolderCheckout[],
  hasTurnChanges: (sessionId: string, repositoryPath: string) => boolean = sessionChangedRepository,
): LiveCheckout[] {
  return folders.flatMap(({ sessionId, path, repositoryPath, branch }) => {
    if (!branch) return []
    const isOwnWorktree = path !== repositoryPath
    return isOwnWorktree || hasTurnChanges(sessionId, repositoryPath) ? [{ projectScope: repositoryPath, branch, sessionId }] : []
  })
}

/**
 * The branch of each checkout that live work runs in: the sessions of tasks
 * that are not finished, and the sessions that are not settled and were
 * active within the list's idle window, after which an idle session is
 * archived. A settled session is not live work. A link, once made, is kept
 * fresh until its session is settled; the window limits only the branch lookup.
 * `ofSessionFolders` adds the other repositories a session works in
 * (`sessionFolderCheckouts`).
 */
export async function liveCheckouts(now: number, ofLiveTasks: LiveTaskSessions, ofSessionFolders: readonly LiveCheckout[] = []): Promise<LiveCheckout[]> {
  const checkouts = [...ofLiveTasks.checkouts]
  const seen = new Set(checkouts.map((checkout) => `${checkout.sessionId}\0${checkout.branch}`))
  const recent = recentBranchSessions(now - SESSION_LIST_IDLE_MS)
    .map((indexed) => ({ ...indexed, sessionId: sessionIdOfThread(indexed.sessionId) }))
  const settled = await settledSessionIds([...recent, ...ofSessionFolders].map((checkout) => checkout.sessionId))
  for (const { sessionId, branch, projectScope } of recent) {
    if (settled.has(sessionId) || seen.has(`${sessionId}\0${branch}`)) continue
    seen.add(`${sessionId}\0${branch}`)
    checkouts.push({ projectScope, branch, sessionId })
  }
  // A session folder is a different repository: the session's branch there is its own, also under the same name.
  const seenInScope = new Set(checkouts.map((checkout) => `${checkout.sessionId}\0${checkout.branch}\0${checkout.projectScope}`))
  for (const checkout of ofSessionFolders) {
    const key = `${checkout.sessionId}\0${checkout.branch}\0${checkout.projectScope}`
    if (settled.has(checkout.sessionId) || seenInScope.has(key)) continue
    seenInScope.add(key)
    checkouts.push(checkout)
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
