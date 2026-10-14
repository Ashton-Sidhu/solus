import { combinedChecksState, type PrChecksSummary } from '@solus/contracts/checks-types'
import type { ChangedFileStat } from '@solus/contracts/git-types'
import type { PrConversationItem, PrFilter, PrInterest, PrPendingWorkflowRuns, PrProjectListing, PrStack, PrSyncChange, PrUnavailableReason, PrViewedFiles, PullRequest, PullRequestOverview, ReviewThread } from '@solus/contracts/providers'
import type { NotificationPr } from '@solus/contracts/notification-hub'
import type { IpcContext, ProjectEntry } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import { projectContext } from '../conversation/lib/ipc-context'
import type { HostConnection } from '../hosts/host-connections'
import { isGithubAuthError } from './lib/pr-presentation'
import { pullRequestRepositoryKey } from './lib/pull-request-list'
import { memoryPullRequestCacheDatabase, PullRequestCache } from './pull-request-cache'
import { HostReads, IDLE, settle, shownValue, type LoadState, type Settled } from './pull-request-reads'

/**
 * Pull requests of every host's projects, read through the host (plan 017
 * stage 5). The host owns the GitHub credential and finds each repository
 * from the project folder; the phone names folders, never `owner/repo`. One
 * project that cannot be read does not hide the others, and one part of a
 * pull request that cannot be read does not hide the rest.
 */

export type ProjectPullRequests =
  /** `cursor` is where the next page starts; null when there is none. A
   *  pull request's checks are its own `checksState`. */
  | { kind: 'page'; projectPath: string; folderName: string; prs: PullRequest[]; hasMore: boolean; page: number; cursor: string | null }
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
  missing: MissingDetailPart[]
  /** Parts the host is still reading, with nothing older to show. A part
   *  here is unknown, not empty. `overview` means the pull request is the
   *  list's row, so its commits and reviewers are not read yet. Absent when
   *  every part is read; never kept on the device. */
  reading?: DetailPart[]
}

export type MissingDetailPart = 'comments' | 'threads' | 'files' | 'checks' | 'workflowRuns'
export type DetailPart = MissingDetailPart | 'overview' | 'stack'

/** A focus that comes back within this time does not read again: PR sync
 *  pushes the pull requests and checks the screen wants kept fresh, and says
 *  when a list must be read again (`listChanged`). */
export const FOCUS_FRESH_MS = 30_000

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

function projectKey(hostId: string, projectPath: string): string {
  return `${hostId}\u0000${projectPath}`
}

/** The answers a detail read has so far. */
interface DetailAnswers {
  overview?: PullRequestOverview
  comments?: Settled<PrConversationItem[]>
  threads?: Settled<ReviewThread[]>
  files?: Settled<ChangedFileStat[]>
  checks?: Settled<PrChecksSummary | null>
  stack?: Settled<PrStack | null>
  workflowRuns?: Settled<PrPendingWorkflowRuns | null>
}

/**
 * The detail as far as it is read: each answered part, else the part shown
 * now (an earlier read, the device copy, or this read's own partial answer),
 * else empty and named in `reading`. Null while there is no pull request to
 * show: no overview, nothing shown, and no list row.
 */
export function composeDetail(answers: DetailAnswers, shown: PullRequestDetail | null, listed: PullRequest | null): PullRequestDetail | null {
  const overview = answers.overview ?? shown?.overview ?? (listed ? { pullRequest: listed, commits: [], reviewers: [] } : null)
  if (!overview) return null
  const reading: DetailPart[] = []
  const missing: MissingDetailPart[] = []
  const isShown = (name: DetailPart) => shown !== null && !(shown.reading?.includes(name) ?? false)
  if (!answers.overview && !isShown('overview')) reading.push('overview')
  const part = <V>(name: DetailPart, missable: MissingDetailPart | null, answer: Settled<V> | undefined, kept: V | undefined, empty: V): V => {
    if (answer) {
      if (!answer.ok && missable) missing.push(missable)
      return answer.ok ? answer.value : empty
    }
    if (shown && isShown(name)) {
      if (missable && shown.missing.includes(missable)) missing.push(missable)
      return kept ?? empty
    }
    reading.push(name)
    return empty
  }
  const detail: PullRequestDetail = {
    overview,
    comments: part('comments', 'comments', answers.comments, shown?.comments, []),
    threads: part('threads', 'threads', answers.threads, shown?.threads, []),
    files: part('files', 'files', answers.files, shown?.files, []),
    checks: part('checks', 'checks', answers.checks, shown?.checks, null),
    stack: part('stack', null, answers.stack, shown?.stack, null),
    missing,
  }
  const workflowRuns = part('workflowRuns', 'workflowRuns', answers.workflowRuns, shown?.workflowRuns, null)
  if (workflowRuns) detail.workflowRuns = workflowRuns
  if (reading.length > 0) detail.reading = reading
  return detail
}

/** Whether a pushed pull request is no older than the one shown. */
function isNotOlder(next: PullRequest, shown: PullRequest): boolean {
  return Date.parse(next.updatedAt) >= Date.parse(shown.updatedAt)
}

/** Whether the list's state filter shows a pull request in this state. */
function stateShows(state: PullRequestListFilter['state'], pr: PullRequest): boolean {
  return state === 'all' || (state === 'open' ? pr.state === 'open' : pr.state !== 'open')
}

/** What one project's screens ask PR sync on the host to keep fresh. */
interface ProjectInterest {
  hostId: string
  projectPath: string
  byScreen: Map<symbol, readonly PrInterest[]>
  /** The set last sent; undefined when the host does not have it. */
  sent?: string
}

export class PullRequestDirectory {
  readonly changes = new Listeners()
  /** Counts changes: a screen that reads several hosts memoizes on it. */
  revision = 0
  private filter: PullRequestListFilter = DEFAULT_PULL_REQUEST_LIST_FILTER
  private readonly hosts = new Map<string, LoadState<HostPullRequests>>()
  private readonly details = new Map<string, LoadState<PullRequestDetail>>()
  private readonly viewed = new Map<string, LoadState<PrViewedFiles>>()
  /** The filter of each list key. */
  private readonly listFilters = new Map<string, PullRequestListFilter>()
  /** When each list and detail key was last read in full. */
  private readonly readAt = new Map<string, number>()
  /** The repository (`host/owner/repo`) of each project, by `projectKey`. */
  private readonly repositories = new Map<string, string>()
  private readonly interests = new Map<string, ProjectInterest>()
  private readonly unsent = new Set<ProjectInterest>()
  private sending = false
  /** The `pr.changed` subscription of each host's current connection. */
  private readonly listening = new Map<string, { connection: HostConnection; stop: () => void }>()
  /** How many screens show the list now. */
  private listsShown = 0
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

  /** Every host the Pull Requests tab shows, read at the same time. With
   *  `freshFor`, a host read in full within that many milliseconds is skipped. */
  async loadHosts(hostIds: readonly string[], options: { freshFor?: number } = {}): Promise<void> {
    await Promise.all(hostIds.map((hostId) => this.loadHost(hostId, options)))
  }

  /**
   * The first page of every project of a host, in one host call. Each row
   * carries its own check state, so the rows show whole as the host lists
   * them; the account follows. The listing
   * starts with the projects shown before while the host names its projects,
   * and is read again only when those differ.
   */
  async loadHost(hostId: string, options: { freshFor?: number } = {}): Promise<void> {
    const filter = this.filter
    const key = listKey(hostId, filter)
    if (this.isFresh(key, this.hosts, options.freshFor)) return
    this.listFilters.set(key, filter)
    await this.reads.read(this.hosts, key, hostId, `list:${filter.state}:${filter.query}`, async (connection, previous, show) => {
      this.listen(hostId, connection)
      const listFor = (paths: string[]) => connection.api.prListProjects(this.context(''), paths, hostFilter(filter))
      const viewerFor = (path: string) => connection.api.providerViewer(this.context(path)).then((answer) => answer.login, () => null)
      const knownPaths = previous?.projects.map((project) => project.projectPath) ?? []
      const early = knownPaths.length > 0 ? settle(listFor(knownPaths)) : null
      const earlyViewer = knownPaths.length > 0 ? viewerFor(knownPaths[0]!) : null
      const projects = projectsWithPullRequests(await connection.api.listProjects())
      if (projects.length === 0) return { projects: [], viewerLogin: null }
      for (const project of projects) this.repositories.set(projectKey(hostId, project.path), project.repositoryKey!)
      const paths = projects.map((project) => project.path)
      const sameProjects = paths.length === knownPaths.length && paths.every((path) => knownPaths.includes(path))
      const reused = early && sameProjects ? await early : null
      const listings = reused?.ok ? reused.value : await listFor(paths)
      const viewerRead = earlyViewer ?? viewerFor(paths[0]!)
      const names = new Map(projects.map((project) => [project.path, project.folderName]))
      const rows = listings.map((listing) => this.listedProject(listing, names))
      // Every project refused for want of GitHub: that is the host's state, not a project's.
      const errors = rows.filter((project) => project.kind === 'error')
      if (errors.length > 0 && errors.length === rows.length && errors.every((project) => isGithubAuthError(project.message))) {
        throw new Error(errors[0]!.message)
      }
      show({ projects: rows, viewerLogin: previous?.viewerLogin ?? null })
      return { projects: rows, viewerLogin: await viewerRead }
    })
    if (this.hosts.get(key)?.kind === 'loaded') this.readAt.set(key, Date.now())
  }

  /** The next page of one project, added below the pages already shown. */
  async loadMore(hostId: string, projectPath: string): Promise<void> {
    const filter = this.filter
    await this.reads.read(this.hosts, listKey(hostId, filter), hostId, `list:${filter.state}:${filter.query}`, async (connection, previous) => {
      const project = previous?.projects.find((candidate) => candidate.projectPath === projectPath)
      // A copy kept on the device by an older version has no cursor to continue from.
      if (!previous || project?.kind !== 'page' || !project.hasMore || !project.cursor) throw new Error('There are no more pull requests to read.')
      const next = await connection.api.prList(this.context(projectPath), hostFilter(filter), project.page + 1, project.cursor)
      const known = new Set(project.prs.map((pr) => pr.number))
      const added = next.items.filter((pr) => !known.has(pr.number))
      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate !== project ? candidate : {
          ...project,
          prs: [...project.prs, ...added],
          hasMore: next.hasMore,
          page: next.page,
          cursor: next.cursor ?? null,
        }),
      }
    })
  }

  /**
   * One pull request with its conversation, threads, files, and checks.
   * Only the pull request itself is required; a missing part is named. Each
   * part shows as soon as it is read, and the list's row shows the pull
   * request until the host answers, so no slow part holds back the rest.
   * With `freshFor`, a detail read in full within that many milliseconds is
   * not read again.
   */
  async loadDetail(ref: PullRequestRef, options: { freshFor?: number } = {}): Promise<void> {
    const key = detailKey(ref)
    if (this.isFresh(key, this.details, options.freshFor)) return
    await this.reads.read(this.details, key, ref.hostId, `detail:${ref.projectPath}:${ref.number}`, async (connection, previous, show) => {
      const ctx = this.context(ref.projectPath)
      const listed = previous ? null : this.listedPullRequest(ref)
      const answers: DetailAnswers = {}
      // What shows now: `previous`, a device copy that came after it, or this read's last part.
      const shown = () => shownValue(this.details.get(key) ?? IDLE)
      const answered = () => {
        const detail = composeDetail(answers, shown(), listed)
        if (detail) show(detail)
      }
      if (listed) answered()
      const overviewRead = connection.api.prGetOverview(ctx, ref.number)
      // Only an open fork pull request can have runs that wait; others skip the call.
      const workflowRunsRead = overviewRead.then(({ pullRequest: pr }) =>
        pr.state === 'open' && pr.headRepo.isFork && pr.capabilities.actions.includes('approve-workflows')
          ? connection.api.prPendingWorkflowRuns(ctx, ref.number)
          : null)
      const checksRead = connection.api.prChecks(ctx, [ref.number]).then((snapshot) => {
        if (snapshot.loadFailed) throw new Error('The host could not read the checks.')
        return snapshot.checks.find((entry) => entry.number === ref.number)?.summary ?? null
      })
      const part = <V>(read: Promise<V>, file: (value: Settled<V>) => void) => settle(read).then((value) => {
        file(value)
        answered()
      })
      await Promise.all([
        overviewRead.then((overview) => {
          answers.overview = overview
          answered()
        }),
        part(connection.api.prListComments(ctx, ref.number), (value) => { answers.comments = value }),
        part(connection.api.prListThreads(ctx, ref.number), (value) => { answers.threads = value }),
        part(connection.api.prChangedFiles(ctx, ref.number), (value) => { answers.files = value }),
        part(checksRead, (value) => { answers.checks = value }),
        part(connection.api.prGetStack(ctx, ref.number), (value) => { answers.stack = value }),
        part(workflowRunsRead, (value) => { answers.workflowRuns = value }),
      ])
      return composeDetail(answers, shown(), listed)!
    })
    if (this.details.get(key)?.kind === 'loaded') this.readAt.set(key, Date.now())
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

  /**
   * Ask PR sync on the host to keep a project's pull requests fresh while a
   * screen shows them (docs/plans/pr-sync.md). The host answers what it knows
   * now, and later changes arrive as `pr.changed`. The screens of one project
   * send one set; releasing the last one tells the host to stop.
   */
  want(hostId: string, projectPath: string, interests: readonly PrInterest[]): () => void {
    const key = projectKey(hostId, projectPath)
    let interest = this.interests.get(key)
    if (!interest) {
      interest = { hostId, projectPath, byScreen: new Map() }
      this.interests.set(key, interest)
    }
    const screen = Symbol('pr-interest')
    interest.byScreen.set(screen, interests)
    this.send(interest)
    const held = interest
    return () => {
      if (!held.byScreen.delete(screen)) return
      this.send(held)
    }
  }

  /**
   * The list is on a screen until the returned function is called. While it
   * is, a host that says a repository's list changed is read again; after,
   * the next focus reads it (docs/plans/pr-sync.md §3.4).
   */
  showList(): () => void {
    this.listsShown += 1
    let shown = true
    return () => {
      if (!shown) return
      shown = false
      this.listsShown -= 1
    }
  }

  forgetHost(hostId: string): void {
    this.reads.forgetHost(this.hosts, hostId)
    this.reads.forgetHost(this.details, hostId)
    this.reads.forgetHost(this.viewed, hostId)
    for (const key of Array.from(this.readAt.keys())) if (key.startsWith(`${hostId}\u0000`)) this.readAt.delete(key)
    for (const [key, interest] of Array.from(this.interests)) if (interest.hostId === hostId) this.interests.delete(key)
    this.listening.get(hostId)?.stop()
    this.listening.delete(hostId)
    this.changes.notify()
  }

  /** The context a call about a project's pull requests sends. */
  context(projectPath: string): IpcContext {
    return projectContext(projectPath, this.organizationId())
  }

  private isFresh<T>(key: string, map: Map<string, LoadState<T>>, freshFor: number | undefined): boolean {
    if (freshFor === undefined) return false
    const readAt = this.readAt.get(key)
    return readAt !== undefined && map.get(key)?.kind === 'loaded' && Date.now() - readAt < freshFor
  }

  /** One project of a listing. */
  private listedProject(listing: PrProjectListing, names: Map<string, string>): ProjectPullRequests {
    const projectPath = listing.projectRoot
    const folderName = names.get(projectPath) ?? projectPath
    if ('page' in listing) {
      const { items, hasMore, page, cursor } = listing.page
      return { kind: 'page', projectPath, folderName, prs: items, hasMore, page, cursor: cursor ?? null }
    }
    if ('unavailable' in listing) return { kind: 'unavailable', projectPath, folderName, reason: listing.unavailable }
    return { kind: 'error', projectPath, folderName, message: listing.error }
  }

  /** The pull request as a list of this host shows it, to show before its detail is read. */
  private listedPullRequest(ref: PullRequestRef): PullRequest | null {
    for (const [key, state] of this.hosts) {
      if (!key.startsWith(`${ref.hostId}\u0000`)) continue
      const project = shownValue(state)?.projects.find((entry) => entry.projectPath === ref.projectPath)
      const pr = project?.kind === 'page' ? project.prs.find((entry) => entry.number === ref.number) : undefined
      if (pr) return pr
    }
    return null
  }

  /** Send changed interests after the current task, so screens that focus together cost one call each. */
  private send(interest: ProjectInterest): void {
    this.unsent.add(interest)
    if (this.sending) return
    this.sending = true
    void Promise.resolve().then(async () => {
      while (this.unsent.size > 0) {
        const batch = Array.from(this.unsent)
        this.unsent.clear()
        await Promise.all(batch.map((next) => this.sendNow(next)))
      }
    }).finally(() => { this.sending = false })
  }

  private async sendNow(interest: ProjectInterest): Promise<void> {
    const key = projectKey(interest.hostId, interest.projectPath)
    if (this.interests.get(key) !== interest) return
    const connection = this.connectionFor(interest.hostId)
    if (!connection) return
    this.listen(interest.hostId, connection)
    const byJson = new Map<string, PrInterest>()
    for (const interests of interest.byScreen.values()) {
      for (const entry of interests) byJson.set(JSON.stringify(entry), entry)
    }
    const signature = JSON.stringify(Array.from(byJson.keys()).sort())
    if (interest.sent === signature) return
    interest.sent = signature
    if (interest.byScreen.size === 0) this.interests.delete(key)
    try {
      const known = await connection.api.prSetInterest(this.context(interest.projectPath), Array.from(byJson.values()))
      this.repositories.set(key, known.repo)
      this.applyChange(interest.hostId, known)
    } catch {
      // A project with no repository has nothing to keep fresh; a lost
      // connection sends again when it is accepted.
      interest.sent = undefined
    }
  }

  /** One `pr.changed` subscription for each host connection. A host forgets
   *  a connection's interest when it drops, so an accepted connection sends
   *  every interest of that host again. */
  private listen(hostId: string, connection: HostConnection): void {
    if (this.listening.get(hostId)?.connection === connection) return
    this.listening.get(hostId)?.stop()
    const stopChanged = connection.events.subscribe('pr.changed', (change) => this.applyChange(hostId, change))
    const stopAccepted = connection.onAccepted(() => {
      for (const interest of this.interests.values()) {
        if (interest.hostId !== hostId) continue
        interest.sent = undefined
        this.send(interest)
      }
    })
    this.listening.set(hostId, { connection, stop: () => { stopChanged(); stopAccepted() } })
  }

  /**
   * Files what PR sync reports in every list and detail of this host that
   * shows the repository: a newer pull request replaces the one shown, and
   * new checks replace old ones. A list without a search also gets a new
   * pull request its state filter shows. Nothing is read again.
   */
  private applyChange(hostId: string, change: PrSyncChange): void {
    if (change.listChanged) this.listChanged(hostId, change.repo)
    if (change.pullRequests.length === 0 && change.checks.length === 0) return
    const pushed = new Map(change.pullRequests.map((pr) => [pr.number, pr]))
    const checks = new Map(change.checks.map((entry) => [entry.number, entry.summary]))
    let changed = false
    for (const [key, state] of this.hosts) {
      if (!key.startsWith(`${hostId}\u0000`)) continue
      const filter = this.listFilters.get(key)
      const next = patchShown(state, (listing) => {
        let touched = false
        const projects = listing.projects.map((project) => {
          if (project.kind !== 'page' || this.repositories.get(projectKey(hostId, project.projectPath)) !== change.repo) return project
          touched = true
          const known = new Set(project.prs.map((pr) => pr.number))
          const added = !filter || filter.query.trim() ? [] : change.pullRequests.filter((pr) => !known.has(pr.number) && stateShows(filter.state, pr))
          const prs = [...added, ...project.prs].map((pr) => {
            const next = pushed.get(pr.number)
            const shown = next && isNotOlder(next, pr) ? next : pr
            // Checks of another head say nothing about this one.
            const summary = checks.get(shown.number)
            return summary && summary.headSha === shown.headSha ? { ...shown, checksState: combinedChecksState(summary) } : shown
          })
          return { ...project, prs }
        })
        return touched ? { ...listing, projects } : listing
      })
      if (next !== state) {
        this.hosts.set(key, next)
        changed = true
      }
    }
    for (const [key, state] of this.details) {
      if (!key.startsWith(`${hostId}\u0000`)) continue
      const next = patchShown(state, (detail) => {
        const shown = detail.overview.pullRequest
        if (pullRequestRepositoryKey(shown) !== change.repo) return detail
        const pr = pushed.get(shown.number)
        const summary = checks.get(shown.number)
        const isNewer = pr !== undefined && isNotOlder(pr, shown)
        if (!isNewer && !summary) return detail
        const next = { ...detail }
        if (isNewer) next.overview = { ...detail.overview, pullRequest: pr }
        if (summary) {
          next.checks = summary
          next.missing = detail.missing.filter((part) => part !== 'checks')
        }
        return next
      })
      if (next !== state) {
        this.details.set(key, next)
        changed = true
      }
    }
    if (changed) this.changes.notify()
  }

  /** Each listing of this host that shows the repository is no longer fresh.
   *  The one on screen is read again now. */
  private listChanged(hostId: string, repo: string): void {
    let isShownStale = false
    for (const [key, state] of this.hosts) {
      if (!key.startsWith(`${hostId}\u0000`)) continue
      const showsRepository = shownValue(state)?.projects.some((project) =>
        project.kind === 'page' && this.repositories.get(projectKey(hostId, project.projectPath)) === repo) ?? false
      if (!showsRepository) continue
      this.readAt.delete(key)
      if (key === listKey(hostId, this.filter)) isShownStale = true
    }
    if (isShownStale && this.listsShown > 0) void this.loadHost(hostId)
  }
}

/** The state with what it shows replaced; the same state when nothing changed. */
function patchShown<T>(state: LoadState<T>, patch: (value: T) => T): LoadState<T> {
  if (state.kind === 'loaded') {
    const value = patch(state.value)
    return value === state.value ? state : { kind: 'loaded', value }
  }
  if (state.kind === 'idle' || state.previous === null) return state
  const previous = patch(state.previous)
  return previous === state.previous ? state : { ...state, previous }
}
