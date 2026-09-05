import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import type { TaskSidebarPrLink } from '@solus/contracts/task-types'
import type { TaskLink } from '@solus/contracts/task-types'

/**
 * The artifacts a pull request has behind it.
 *
 * No new link kind: a review session's task is linked to the PR at first
 * dispatch, and `render_artifact` links the work to that same task. So the PR
 * already reaches its renders through the task graph, and the page only has to
 * read the edges both ends already wrote.
 */
export interface PrArtifact {
  workId: string
  title: string
  /** The task the artifact reached this pull request through. */
  taskId: string
  taskTitle: string
  /** When the artifact was linked to that task: the moment it joins the
   *  pull request's timeline. */
  linkedAt: number
}

/** One task's contribution: its identity and the links it holds. */
export interface PrArtifactSource {
  taskId: string
  taskTitle: string
  links: TaskLink[]
}

/** `liveStatus` on a `work` link is the work's type, kept live by the host so a
 *  link row can say what it points at without a second read. */
const ARTIFACT_LINK = (link: TaskLink) => link.kind === 'work' && link.liveStatus === 'artifact'

/** Deduped by work id, newest task first. Two tasks on the same pull request
 *  frequently link the same artifact — a review and its follow-up — and the
 *  reader wants one card, credited to the first task that produced it. */
export function prArtifactsFrom(sources: PrArtifactSource[]): PrArtifact[] {
  const byWorkId = new Map<string, PrArtifact>()
  for (const source of sources) {
    for (const link of source.links) {
      if (!ARTIFACT_LINK(link) || byWorkId.has(link.targetKey)) continue
      byWorkId.set(link.targetKey, {
        workId: link.targetKey,
        title: link.liveTitle || link.title,
        taskId: source.taskId,
        taskTitle: source.taskTitle,
        linkedAt: link.linkedAt,
      })
    }
  }
  return [...byWorkId.values()]
}

/** A PR number is only unique within its repository on its owning host. */
export function taskLinksToPr(
  links: TaskSidebarPrLink[],
  taskServerId: string | null,
  serverId: string,
  prUrl: string | null,
): boolean {
  if (taskServerId !== serverId || !prUrl) return false
  const pr = parseGitHubPullRequestUrl(prUrl)
  if (!pr) return false
  const scope = [pr.baseRepo.host, pr.baseRepo.owner, pr.baseRepo.repo].join('/').toLowerCase()
  return links.some((link) => {
    if (link.number !== pr.number) return false
    if (link.targetScope?.toLowerCase() === scope) return true
    const linked = link.url ? parseGitHubPullRequestUrl(link.url) : null
    return linked?.url.toLowerCase() === pr.url.toLowerCase()
  })
}
