import type { PrChecksState, PrChecksSummary } from '@solus/contracts/checks-types'
import type { ChangedFileStat } from '@solus/contracts/git-types'
import type { PrConversationItem, PrFilter, PrPendingWorkflowRuns, PrStack, PrUnavailableReason, PrViewedFiles, PullRequest, PullRequestOverview, ReviewThread } from '@solus/contracts/providers'
import type { NotificationPr } from '@solus/contracts/notification-hub'
import type { IpcContext, ProjectEntry } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import { projectContext } from '../conversation/lib/ipc-context'
import type { HostConnection } from '../hosts/host-connections'
import { isGithubAuthError } from './lib/pr-presentation'
import { memoryPullRequestCacheDatabase, PullRequestCache } from './pull-request-cache'
import { HostReads, IDLE, settle, type LoadState } from './pull-request-reads'

/**
 * Pull requests of every host's projects, read through the host (plan 017
 * stage 5). The host owns the GitHub credential and finds each repository
 * from the project folder; the phone names folders, never `owner/repo`. One
 * project that cannot be read does not hide the others, and one part of a
 * pull request that cannot be read does not hide the rest.
 */

/** The checks of one listed pull request, for the checks filter. */
export interface ListedChecks {
  number: number
  state: PrChecksState
  headSha: string
}

export type ProjectPullRequests =
  | { kind: 'page'; projectPath: string; folderName: string; prs: PullRequest[]; hasMore: boolean; page: number; checks: ListedChecks[] }
  | { kind: 'unavailable'; projectPath: string; folderName: string; reason: PrUnavailableReason }
  | { kind: 'error'; projectPath: string; folderName: string; message: string }

export interface HostPullRequests {
  projects: ProjectPullRequests[]
  /** The GitHub account the host acts as; null when it did not say. */
  viewerLogin: string | null
}

/** What the host narrows: the state, and the code host's search text
 *  (qualifiers included, as in `label:bug fix`). */
export interface PullRequestListFilter {
  state: NonNullable<PrFilter['state']>
  query: string
}

export const DEFAULT_PULL_REQUEST_LIST_FILTER: PullRequestListFilter = { state: 'open', query: '' }

export interface PullRequestDetail {
  /** The pull request with its commits and reviewers: the host reads both
   *  for the overview, so a separate read would ask twice. */
  overview: PullRequestOverview
  comments: PrConversationItem[]
  /** Inline review threads, for the diff and the Activity tab. */
  threads: ReviewThread[]
  files: ChangedFileStat[]
  checks: PrChecksSummary | null
  /** The GitHub stack it is in; null when in none or the read failed. */
  stack: PrStack | null
  /** The workflow runs of a fork pull request that wait for approval. Read
   *  only for an open fork pull request on a host that can approve them;
   *  absent otherwise, and in a device copy from an older version. */
  workflowRuns?: PrPendingWorkflowRuns
  /** Parts the host could not read; the rest still shows. */
  missing: ('comments' | 'threads' | 'files' | 'checks' | 'workflowRuns')[]
}

export interface PullRequestRef {
  hostId: string
  projectPath: string
  number: number
}

export function detailKey(ref: PullRequestRef): string {
  return `${ref.hostId}\u0000${ref.projectPath}\u0000${ref.number}`
}

/** The repository a notification names, as a project's `repositoryKey`
 *  writes it: lowercase `host/owner/repo`. */
export function notificationRepositoryKey(pr: Pick<NotificationPr, 'host' | 'owner' | 'repo'>): string {
  return `${pr.host}/${pr.owner}/${pr.repo}`.toLowerCase()
}

/** A project with no repository key has no remote to read pull requests from. */
export function projectsWithPullRequests(projects: readonly ProjectEntry[]): ProjectEntry[] {
  return projects.filter((project) => project.repositoryKey !== null)
}

function listKey(hostId: string, filter: PullRequestListFilter): string {
  return `${hostId}\u0000${filter.state}\u0000${filter.query}`
}

function hostFilter(filter: PullRequestListFilter): PrFilter {
  return filter.query.trim() ? { state: filter.state, query: filter.query.trim() } : { state: filter.state }
}

export class PullRequestDirectory {
  readonly changes = new Listeners()
  /** Counts changes: a screen that reads several hosts memoizes on it. */
  revision = 0
  private filter: PullRequestListFilter = DEFAULT_PULL_REQUEST_LIST_FILTER
  private readonly hosts = new Map<string, LoadState<HostPullRequests>>()
  private readonly details = new Map<string, LoadState<PullRequestDetail>>()
  private readonly viewed = new Map<string, LoadState<PrViewedFiles>>()
  private readonly reads: HostReads

  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly organizationId: () => string | null,
    cache: PullRequestCache = new PullRequestCache(memoryPullRequestCacheDatabase()),
  ) {
    this.reads = new HostReads(this.changes, connectionFor, cache)
    this.changes.subscribe(() => { this.revision += 1 })
  }

  listFilter = (): PullRequestListFilter => this.filter

  /** Changes what the host lists. Each filter has its own reads; the caller
   *  loads the hosts it shows after this. */
  setListFilter(filter: PullRequestListFilter): void {
    this.filter = filter
    this.changes.notify()
  }

  /** The host's listing for the current list filter. */
  hostOf = (hostId: string): LoadState<HostPullRequests> => this.hosts.get(listKey(hostId, this.filter)) ?? IDLE

  detailOf = (ref: PullRequestRef): LoadState<PullRequestDetail> => this.details.get(detailKey(ref)) ?? IDLE

  /** The files the person marked viewed, as the code host keeps them. */
  viewedOf = (ref: PullRequestRef): LoadState<PrViewedFiles> => this.viewed.get(detailKey(ref)) ?? IDLE

  /** Every host the Pull Requests tab shows, read at the same time. */
  async loadHosts(hostIds: readonly string[]): Promise<void> {
    await Promise.all(hostIds.map((hostId) => this.loadHost(hostId)))
  }

  /** The first page of every project of a host, in one host call. */
  async loadHost(hostId: string): Promise<void> {
    const filter = this.filter
    await this.reads.read(this.hosts, listKey(hostId, filter), hostId, `list:${filter.state}:${filter.query}`, async (connection) => {
      const projects = projectsWithPullRequests(await connection.api.listProjects())
      if (projects.length === 0) return { projects: [], viewerLogin: null }
      const names = new Map(projects.map((project) => [project.path, project.folderName]))
      const [listings, viewer] = await Promise.all([
        connection.api.prListProjects(this.context(''), projects.map((project) => project.path), hostFilter(filter)),
        connection.api.providerViewer(this.context(projects[0]!.path)).then((answer) => answer.login, () => null),
      ])
      const read = await Promise.all(listings.map(async (listing): Promise<ProjectPullRequests> => {
        const projectPath = listing.projectRoot
        const folderName = names.get(projectPath) ?? projectPath
        if ('page' in listing) {
          const { items, hasMore, page } = listing.page
          return { kind: 'page', projectPath, folderName, prs: items, hasMore, page, checks: await this.listedChecks(connection, projectPath, items) }
        }
        if ('unavailable' in listing) return { kind: 'unavailable', projectPath, folderName, reason: listing.unavailable }
        return { kind: 'error', projectPath, folderName, message: listing.error }
      }))
      // Every project refused for want of GitHub: that is the host's state, not a project's.
      const errors = read.filter((project) => project.kind === 'error')
      if (errors.length > 0 && errors.length === read.length && errors.every((project) => isGithubAuthError(project.message))) {
        throw new Error(errors[0]!.message)
      }
      return { projects: read, viewerLogin: viewer }
    })
  }

  /** The next page of one project, added below the pages already shown. */
  async loadMore(hostId: string, projectPath: string): Promise<void> {
    const filter = this.filter
    await this.reads.read(this.hosts, listKey(hostId, filter), hostId, `list:${filter.state}:${filter.query}`, async (connection, previous) => {
      const project = previous?.projects.find((candidate) => candidate.projectPath === projectPath)
      if (!previous || project?.kind !== 'page' || !project.hasMore) throw new Error('There are no more pull requests to read.')
      const next = await connection.api.prList(this.context(projectPath), hostFilter(filter), project.page + 1)
      const known = new Set(project.prs.map((pr) => pr.number))
      const added = next.items.filter((pr) => !known.has(pr.number))
      const checks = await this.listedChecks(connection, projectPath, added)
      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate !== project ? candidate : {
          ...project,
          prs: [...project.prs, ...added],
          hasMore: next.hasMore,
          page: next.page,
          checks: [...project.checks, ...checks],
        }),
      }
    })
  }

  /** One pull request with its conversation, threads, files, and checks.
   *  Only the pull request itself is required; a missing part is named. */
  async loadDetail(ref: PullRequestRef): Promise<void> {
    await this.reads.read(this.details, detailKey(ref), ref.hostId, `detail:${ref.projectPath}:${ref.number}`, async (connection) => {
      const ctx = this.context(ref.projectPath)
      const overviewRead = connection.api.prGetOverview(ctx, ref.number)
      // Only an open fork pull request can have runs that wait; others skip the call.
      const workflowRunsRead = settle(overviewRead.then(({ pullRequest: pr }) =>
        pr.state === 'open' && pr.headRepo.isFork && pr.capabilities.actions.includes('approve-workflows')
          ? connection.api.prPendingWorkflowRuns(ctx, ref.number)
          : null))
      const [overview, comments, threads, files, checks, stack, workflowRuns] = await Promise.all([
        overviewRead,
        settle(connection.api.prListComments(ctx, ref.number)),
        settle(connection.api.prListThreads(ctx, ref.number)),
        settle(connection.api.prChangedFiles(ctx, ref.number)),
        settle(connection.api.prChecks(ctx, [ref.number])),
        settle(connection.api.prGetStack(ctx, ref.number)),
        workflowRunsRead,
      ])
      const missing: PullRequestDetail['missing'] = []
      if (!comments.ok) missing.push('comments')
      if (!threads.ok) missing.push('threads')
      if (!files.ok) missing.push('files')
      if (!checks.ok || checks.value.loadFailed) missing.push('checks')
      if (!workflowRuns.ok) missing.push('workflowRuns')
      const detail: PullRequestDetail = {
        overview,
        comments: comments.ok ? comments.value : [],
        threads: threads.ok ? threads.value : [],
        files: files.ok ? files.value : [],
        checks: checks.ok ? checks.value.checks.find((entry) => entry.number === ref.number)?.summary ?? null : null,
        stack: stack.ok ? stack.value : null,
        missing,
      }
      if (workflowRuns.ok && workflowRuns.value) detail.workflowRuns = workflowRuns.value
      return detail
    })
  }

  /** The viewed state of a pull request's files on the code host. Only a host
   *  whose pull request has `capabilities.viewedFiles` answers it. */
  async loadViewed(ref: PullRequestRef): Promise<void> {
    await this.reads.read(this.viewed, detailKey(ref), ref.hostId, `viewed-files:${ref.projectPath}:${ref.number}`, (connection) =>
      connection.api.prViewedFiles(this.context(ref.projectPath), ref.number))
  }

  /**
   * Where a notification's pull request can be read on this device: the first
   * of `hostIds` with a project of that repository. A notification names the
   * repository, never a folder, so the folder is found on the host.
   */
  async locate(pr: NotificationPr, hostIds: readonly string[]): Promise<PullRequestRef | null> {
    const key = notificationRepositoryKey(pr)
    for (const hostId of hostIds) {
      const connection = this.connectionFor(hostId)
      if (!connection || connection.state.phase !== 'connected') continue
      const projects = await connection.api.listProjects().catch(() => [])
      const project = projects.find((candidate) => candidate.repositoryKey === key)
      if (project) return { hostId, projectPath: project.path, number: pr.number }
    }
    return null
  }

  forgetHost(hostId: string): void {
    this.reads.forgetHost(this.hosts, hostId)
    this.reads.forgetHost(this.details, hostId)
    this.reads.forgetHost(this.viewed, hostId)
    this.changes.notify()
  }

  /** The context a call about a project's pull requests sends. */
  context(projectPath: string): IpcContext {
    return projectContext(projectPath, this.organizationId())
  }

  /** The checks of listed pull requests; a failed read only leaves them unknown. */
  private async listedChecks(connection: HostConnection, projectPath: string, prs: readonly PullRequest[]): Promise<ListedChecks[]> {
    if (prs.length === 0) return []
    const snapshot = await settle(connection.api.prChecks(this.context(projectPath), prs.map((pr) => pr.number)))
    if (!snapshot.ok || snapshot.value.loadFailed) return []
    return snapshot.value.checks.map((entry) => ({ number: entry.number, state: entry.summary.state, headSha: entry.summary.headSha }))
  }
}
