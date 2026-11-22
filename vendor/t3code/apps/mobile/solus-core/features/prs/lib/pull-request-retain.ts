import { keepEqual, sameItems } from '@solus/client-core/keep-equal'
import type { HostPullRequests, ProjectPullRequests, PullRequestDetail } from '../pull-request-directory'

/**
 * A pull request answer read again or pushed by PR sync, with what did not
 * change kept as the object shown (`HostReads` `retain`). A screen that
 * selects the value, and a memoized row, then render only what changed; the
 * read state still goes from loading to loaded. When all of it is equal, the
 * shown value itself comes back.
 */

/** Projects pair by folder and pull requests by number, so a pull request
 *  that moved up the page keeps its object too. */
export function retainListing(next: HostPullRequests, shown: HostPullRequests): HostPullRequests {
  const held = new Map(shown.projects.map((project) => [project.projectPath, project]))
  const projects = next.projects.map((project) => retainProject(project, held.get(project.projectPath)))
  const { projects: _projects, ...rest } = next
  const { projects: _shownProjects, ...shownRest } = shown
  const isSameList = sameItems(projects, shown.projects)
  if (isSameList && keepEqual(rest, shownRest) === shownRest) return shown
  return { ...next, projects: isSameList ? shown.projects : projects }
}

function retainProject(next: ProjectPullRequests, shown: ProjectPullRequests | undefined): ProjectPullRequests {
  if (!shown) return next
  if (next.kind !== 'page' || shown.kind !== 'page') return keepEqual(next, shown)
  const held = new Map(shown.prs.map((pr) => [pr.number, pr]))
  const prs = next.prs.map((pr) => {
    const kept = held.get(pr.number)
    return kept ? keepEqual(pr, kept) : pr
  })
  const { prs: _prs, ...page } = next
  const { prs: _shownPrs, ...shownPage } = shown
  const isSameList = sameItems(prs, shown.prs)
  if (isSameList && keepEqual(page, shownPage) === shownPage) return shown
  return { ...next, prs: isSameList ? shown.prs : prs }
}

/** Each part of the detail keeps its object when it is equal, so a tab that
 *  reads one part does not render again for another. */
export function retainDetail(next: PullRequestDetail, shown: PullRequestDetail): PullRequestDetail {
  const { overview, comments, threads, files, checks, stack, ...rest } = next
  const { overview: shownOverview, comments: shownComments, threads: shownThreads, files: shownFiles, checks: shownChecks, stack: shownStack, ...shownRest } = shown
  const kept: PullRequestDetail = {
    ...rest,
    overview: keepEqual(overview, shownOverview),
    comments: keepEqual(comments, shownComments),
    threads: keepEqual(threads, shownThreads),
    files: keepEqual(files, shownFiles),
    checks: keepEqual(checks, shownChecks),
    stack: keepEqual(stack, shownStack),
  }
  const isSame = kept.overview === shownOverview && kept.comments === shownComments && kept.threads === shownThreads
    && kept.files === shownFiles && kept.checks === shownChecks && kept.stack === shownStack
    // What is left is small: the parts missing or still read, and the waiting runs.
    && keepEqual(rest, shownRest) === shownRest
  return isSame ? shown : kept
}
