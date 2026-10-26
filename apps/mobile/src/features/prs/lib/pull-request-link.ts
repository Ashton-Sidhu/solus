import { isInsideHostPath } from '@solus/contracts/host-path'
import { parsePullRequestHref, type RepoRef } from '@solus/contracts/providers'
import type { ProjectEntry } from '@solus/contracts/types'
import type { PullRequestRef } from '../pull-request-directory'
import { pullRequestRepositoryKey } from './pull-request-list'

/**
 * Where a pull request link in a transcript opens in the app, as on web: in
 * the project of the transcript's working directory, or another project of
 * the link's repository on the same host. Null when no project of the host
 * can read it; the caller opens the link in the browser.
 *
 * A `pr://` link (no `baseRepo`) names a pull request of the transcript's own
 * project, so it opens there only.
 */
export function pullRequestLinkRef(
  link: { number: number; baseRepo: RepoRef | null },
  hostId: string,
  workingDirectory: string,
  projects: readonly Pick<ProjectEntry, 'path' | 'repositoryKey'>[],
): PullRequestRef | null {
  const own = workingDirectory
    ? projects.find((project) => isInsideHostPath(project.path, workingDirectory))
    : undefined
  if (link.baseRepo === null) {
    // A project with no hosted remote has no pull requests to read.
    if (!workingDirectory || own?.repositoryKey === null) return null
    return { hostId, projectPath: own?.path ?? workingDirectory, number: link.number }
  }
  const key = pullRequestRepositoryKey({ baseRepo: link.baseRepo })
  const project = own?.repositoryKey === key ? own : projects.find((candidate) => candidate.repositoryKey === key)
  return project ? { hostId, projectPath: project.path, number: link.number } : null
}

/** Where the Markdown that holds a link was written: a transcript's working
 *  directory, or a pull request's own project for its description, comments,
 *  and guide. */
export interface PullRequestLinkPlace {
  hostId: string
  workingDirectory: string
}

export interface PullRequestLinkActions {
  listProjects(hostId: string): Promise<readonly Pick<ProjectEntry, 'path' | 'repositoryKey'>[]>
  openPullRequest(ref: PullRequestRef): void
  openBrowser(href: string): void
}

/**
 * Opens a pull request link as on desktop and web: the PullRequest screen
 * when a project of the host reads it (`pullRequestLinkRef`), else a GitHub
 * link in the browser. A `pr://` link no project reads does nothing. Null
 * when `href` is not a pull request link, so the caller opens it.
 */
export function openPullRequestLink(href: string, place: PullRequestLinkPlace | null, actions: PullRequestLinkActions): Promise<void> | null {
  const link = parsePullRequestHref(href)
  if (!link) return null
  return (async () => {
    const projects = place ? await actions.listProjects(place.hostId).catch(() => []) : []
    const ref = place ? pullRequestLinkRef(link, place.hostId, place.workingDirectory, projects) : null
    if (ref) actions.openPullRequest(ref)
    else if (link.baseRepo) actions.openBrowser(href)
  })()
}
