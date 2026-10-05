import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { ChangedFileStat } from '@solus/contracts/git-types'
import type { PrConversationItem, PrReviewVerdict, PrUnavailableReason, PullRequest, PullRequestOverview } from '@solus/contracts/providers'
import type { NotificationPr } from '@solus/contracts/notification-hub'
import type { ProjectEntry } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import { projectContext } from '../conversation/lib/ipc-context'
import type { HostConnection } from '../hosts/host-connections'
import { isGithubAuthError } from './lib/pr-presentation'

/**
 * Pull requests of a host's projects, read through the host (plan 017 stage 5).
 * The host owns the GitHub credential and finds each repository from the
 * project folder; the phone names folders, never `owner/repo`. One project
 * that cannot be read does not hide the others.
 */

export type ProjectPullRequests =
  | { kind: 'page'; projectPath: string; folderName: string; prs: PullRequest[]; hasMore: boolean }
  | { kind: 'unavailable'; projectPath: string; folderName: string; reason: PrUnavailableReason }
  | { kind: 'error'; projectPath: string; folderName: string; message: string }

export interface HostPullRequests {
  projects: ProjectPullRequests[]
  /** The GitHub account the host acts as; null when it did not say. */
  viewerLogin: string | null
}

/** A read and what it last showed. `githubAuth`: the host has no working
 *  GitHub connection, so the answer is to connect it, not to retry. */
export type LoadState<T> =
  | { kind: 'idle' }
  | { kind: 'loading'; previous: T | null }
  | { kind: 'loaded'; value: T }
  | { kind: 'error'; message: string; githubAuth: boolean; previous: T | null }

/** What a state can still show: the value, or the last one while reading again. */
export function shownValue<T>(state: LoadState<T>): T | null {
  return state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
}

export interface PullRequestDetail {
  overview: PullRequestOverview
  comments: PrConversationItem[]
  files: ChangedFileStat[]
  checks: PrChecksSummary | null
  /** Parts the host could not read; the rest still shows. */
  missing: ('comments' | 'files' | 'checks')[]
}

export interface PullRequestRef {
  hostId: string
  projectPath: string
  number: number
}

const IDLE = { kind: 'idle' } as const

const VERDICT_EVENTS = {
  comment: 'COMMENT',
  approve: 'APPROVE',
  'request-changes': 'REQUEST_CHANGES',
} as const satisfies Record<PrReviewVerdict, string>

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

export class PullRequestDirectory {
  readonly changes = new Listeners()
  private readonly hosts = new Map<string, LoadState<HostPullRequests>>()
  private readonly details = new Map<string, LoadState<PullRequestDetail>>()
  private readonly requests = new Map<string, number>()
  private nextRequest = 0

  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly organizationId: () => string | null,
  ) {}

  hostOf = (hostId: string): LoadState<HostPullRequests> => this.hosts.get(hostId) ?? IDLE

  detailOf = (ref: PullRequestRef): LoadState<PullRequestDetail> => this.details.get(detailKey(ref)) ?? IDLE

  /** Every open pull request of the host's projects, in one host call. */
  async loadHost(hostId: string): Promise<void> {
    await this.read(this.hosts, hostId, hostId, async (connection) => {
      const projects = projectsWithPullRequests(await connection.api.listProjects())
      if (projects.length === 0) return { projects: [], viewerLogin: null }
      const names = new Map(projects.map((project) => [project.path, project.folderName]))
      const [listings, viewer] = await Promise.all([
        connection.api.prListProjects(this.context(''), projects.map((project) => project.path), { state: 'open' }),
        connection.api.providerViewer(this.context(projects[0]!.path)).then((answer) => answer.login, () => null),
      ])
      const read: ProjectPullRequests[] = listings.map((listing) => {
        const folderName = names.get(listing.projectRoot) ?? listing.projectRoot
        if ('page' in listing) return { kind: 'page', projectPath: listing.projectRoot, folderName, prs: listing.page.items, hasMore: listing.page.hasMore }
        if ('unavailable' in listing) return { kind: 'unavailable', projectPath: listing.projectRoot, folderName, reason: listing.unavailable }
        return { kind: 'error', projectPath: listing.projectRoot, folderName, message: listing.error }
      })
      // Every project refused for want of GitHub: that is the host's state, not a project's.
      const errors = read.filter((project) => project.kind === 'error')
      if (errors.length > 0 && errors.length === read.length && errors.every((project) => isGithubAuthError(project.message))) {
        throw new Error(errors[0]!.message)
      }
      return { projects: read, viewerLogin: viewer }
    })
  }

  /** One pull request with its conversation, files, and checks. Only the
   *  pull request itself is required; a missing part is named instead. */
  async loadDetail(ref: PullRequestRef): Promise<void> {
    await this.read(this.details, detailKey(ref), ref.hostId, async (connection) => {
      const ctx = this.context(ref.projectPath)
      const [overview, comments, files, checks] = await Promise.all([
        connection.api.prGetOverview(ctx, ref.number),
        settle(connection.api.prListComments(ctx, ref.number)),
        settle(connection.api.prChangedFiles(ctx, ref.number)),
        settle(connection.api.prChecks(ctx, [ref.number])),
      ])
      const missing: PullRequestDetail['missing'] = []
      if (!comments.ok) missing.push('comments')
      if (!files.ok) missing.push('files')
      if (!checks.ok || checks.value.loadFailed) missing.push('checks')
      return {
        overview,
        comments: comments.ok ? comments.value : [],
        files: files.ok ? files.value : [],
        checks: checks.ok ? checks.value.checks.find((entry) => entry.number === ref.number)?.summary ?? null : null,
        missing,
      }
    })
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

  /** A comment on the pull request's conversation, then a fresh read. */
  async comment(ref: PullRequestRef, body: string): Promise<void> {
    const connection = this.require(ref.hostId)
    await connection.api.prAddIssueComment(this.context(ref.projectPath), ref.number, body.trim())
    await this.loadDetail(ref)
  }

  /** Approve, request changes, or leave a review comment, on the head the
   *  person was shown: a head that moved since makes the host refuse. */
  async review(ref: PullRequestRef, verdict: PrReviewVerdict, body: string, headSha: string): Promise<void> {
    const connection = this.require(ref.hostId)
    await connection.api.prSubmitReview(this.context(ref.projectPath), ref.number, {
      body: body.trim(),
      event: VERDICT_EVENTS[verdict],
      commitId: headSha,
      comments: [],
    })
    await this.loadDetail(ref)
  }

  forgetHost(hostId: string): void {
    this.hosts.delete(hostId)
    for (const key of Array.from(this.details.keys())) if (key.startsWith(`${hostId}\u0000`)) this.details.delete(key)
    this.changes.notify()
  }

  private context(projectPath: string) {
    return projectContext(projectPath, this.organizationId())
  }

  private require(hostId: string): HostConnection {
    const connection = this.connectionFor(hostId)
    if (!connection) throw new Error('This host cannot be reached now.')
    return connection
  }

  /** A read that a newer read of the same key, or a new server session,
   *  makes stale is dropped rather than shown. */
  private async read<T>(
    map: Map<string, LoadState<T>>,
    key: string,
    hostId: string,
    run: (connection: HostConnection) => Promise<T>,
  ): Promise<void> {
    const previous = shownValue(map.get(key) ?? IDLE)
    const failed = (message: string): LoadState<T> => ({ kind: 'error', message, githubAuth: isGithubAuthError(message), previous })
    const connection = this.connectionFor(hostId)
    if (!connection) {
      map.set(key, failed('This host cannot be reached now.'))
      this.changes.notify()
      return
    }
    const request = ++this.nextRequest
    const generation = connection.state.sessionGeneration
    this.requests.set(key, request)
    map.set(key, { kind: 'loading', previous })
    this.changes.notify()
    let next: LoadState<T>
    try {
      next = { kind: 'loaded', value: await run(connection) }
    } catch (error) {
      next = failed(error instanceof Error ? error.message : String(error))
    }
    const isCurrent = this.requests.get(key) === request
      && this.connectionFor(hostId) === connection
      && connection.state.sessionGeneration === generation
    if (!isCurrent) return
    map.set(key, next)
    this.changes.notify()
  }
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await promise }
  } catch {
    return { ok: false }
  }
}
