// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestList.ts (MIT, see UPSTREAM.md).
import type { PrChecksState } from '@solus/contracts/checks-types'
import type { PullRequest } from '@solus/contracts/providers'
import type { HostPullRequests } from '../pull-request-directory'

/**
 * The Pull Requests tab's rows: every connected host's pull requests in one
 * list, then the filters and the sort the person chose. The host answers the
 * state (open, closed, all) and the search text; everything here narrows the
 * rows the device already holds.
 */

/** One row: a pull request, the host and project it came from, and its checks. */
export interface PullRequestRow {
  hostId: string
  projectPath: string
  folderName: string
  pr: PullRequest
  /** The checks for the pull request's current head; null when unknown. */
  checks: PrChecksState | null
}

export type PullRequestInvolvement = 'all' | 'authored' | 'reviewing' | 'others'
export type PullRequestListSort = 'updated' | 'created' | 'oldest'
export type PullRequestReviewFilter = 'approved' | 'changes-requested' | 'review-required' | 'none'

export interface PullRequestListFilters {
  /** Each group needs one of its labels; every group must match. */
  labels?: string[][]
  excludedLabels?: string[]
  /** A login, or `me` for the host's own account. */
  author?: string
  draft?: 'only' | 'hide'
  review?: PullRequestReviewFilter
  checks?: Exclude<PrChecksState, 'none'>
}

/** What the device narrows. The host-side `state` and `query` are
 *  `PullRequestListFilter` in the directory. */
export interface PullRequestListControls {
  involvement: PullRequestInvolvement
  filters: PullRequestListFilters
  /** Only this host; absent for every host. */
  hostId?: string
  /** Only this project of `hostId`. */
  projectPath?: string
  sort: PullRequestListSort
}

export const DEFAULT_PULL_REQUEST_LIST_CONTROLS: PullRequestListControls = {
  involvement: 'all',
  filters: {},
  sort: 'updated',
}

/** One pull request on one host: the identity a row and its screen share. */
export function pullRequestRowKey(row: Pick<PullRequestRow, 'hostId' | 'pr'>): string {
  return `${row.hostId}\u0000${pullRequestRepositoryKey(row.pr)}#${row.pr.number}`
}

/** A pull request's repository as a project's `repositoryKey` writes it: lowercase `host/owner/repo`. */
export function pullRequestRepositoryKey(pr: Pick<PullRequest, 'baseRepo'>): string {
  return `${pr.baseRepo.host}/${pr.baseRepo.owner}/${pr.baseRepo.repo}`.toLowerCase()
}

/** Every readable project of every host, in host order. A project that could
 *  not be read gives no rows; the host listing names it. A row of `previous`
 *  whose pull request and project did not change is kept, so a memoized row
 *  does not render again. */
export function pullRequestRows(listings: readonly { hostId: string; listing: HostPullRequests | null }[], previous: readonly PullRequestRow[] = []): PullRequestRow[] {
  const held = new Map(previous.map((row) => [row.pr, row]))
  const rows: PullRequestRow[] = []
  for (const { hostId, listing } of listings) {
    for (const project of listing?.projects ?? []) {
      if (project.kind !== 'page') continue
      for (const pr of project.prs) {
        const kept = held.get(pr)
        rows.push(kept && kept.hostId === hostId && kept.projectPath === project.projectPath && kept.folderName === project.folderName ? kept : {
          hostId,
          projectPath: project.projectPath,
          folderName: project.folderName,
          pr,
          checks: pr.checksState && pr.checksState !== 'none' ? pr.checksState : null,
        })
      }
    }
  }
  return rows
}

const normalize = (value: string) => value.toLowerCase()

/**
 * The rows the controls keep, sorted. `viewerOf` answers each host's GitHub
 * account, so "authored" and `author: me` follow the account of the host
 * that listed the row. One repository can be a project on two hosts: the
 * first matching row of a pull request stays, unless its host is not in
 * `connectedHostIds` and a connected host lists it too. A row from a host
 * that is not connected can be only the device copy.
 */
export function filterPullRequestRows(
  rows: readonly PullRequestRow[],
  controls: PullRequestListControls,
  viewerOf: (hostId: string) => string | null,
  connectedHostIds?: ReadonlySet<string>,
): PullRequestRow[] {
  const kept = rows.filter((row) => {
    if (controls.hostId && row.hostId !== controls.hostId) return false
    if (controls.projectPath && row.projectPath !== controls.projectPath) return false
    const viewer = viewerOf(row.hostId)
    return matchesInvolvement(row.pr, controls.involvement, viewer) && matchesFilters(row, controls.filters, viewer)
  })
  const reachable = (row: PullRequestRow) => !connectedHostIds || connectedHostIds.has(row.hostId)
  const unique = new Map<string, PullRequestRow>()
  for (const row of kept) {
    const key = `${pullRequestRepositoryKey(row.pr)}#${row.pr.number}`
    const held = unique.get(key)
    if (!held || (!reachable(held) && reachable(row))) unique.set(key, row)
  }
  const byTime = (field: 'createdAt' | 'updatedAt', a: PullRequestRow, b: PullRequestRow) => Date.parse(a.pr[field]) - Date.parse(b.pr[field])
  return Array.from(unique.values()).sort((a, b) =>
    controls.sort === 'created' ? byTime('createdAt', b, a)
      : controls.sort === 'oldest' ? byTime('updatedAt', a, b)
        : byTime('updatedAt', b, a))
}

function matchesInvolvement(pr: PullRequest, involvement: PullRequestInvolvement, viewer: string | null): boolean {
  const authored = viewer !== null && normalize(pr.author) === normalize(viewer)
  if (involvement === 'authored') return authored
  if (involvement === 'reviewing') return !!pr.needsMyReview
  if (involvement === 'others') return !authored && !pr.needsMyReview
  return true
}

function matchesFilters(row: PullRequestRow, filters: PullRequestListFilters, viewer: string | null): boolean {
  const { pr } = row
  if ((filters.draft === 'only' && !pr.draft) || (filters.draft === 'hide' && pr.draft)) return false
  if (filters.author) {
    const author = filters.author === 'me' ? viewer : filters.author
    if (!author || normalize(pr.author) !== normalize(author)) return false
  }
  if (filters.review && !matchesReview(pr.reviewStatus, filters.review)) return false
  // A row whose checks are not known yet is not hidden by a checks filter.
  if (filters.checks && row.checks && row.checks !== filters.checks) return false
  const labels = new Set(pr.labels.map((label) => normalize(label.name)))
  if (filters.labels?.some((group) => !group.some((label) => labels.has(normalize(label))))) return false
  return !filters.excludedLabels?.some((label) => labels.has(normalize(label)))
}

/** A host that gives no review summary is not filtered by one, except for
 *  "none", which asks for pull requests with no review. */
function matchesReview(status: PullRequest['reviewStatus'], filter: PullRequestReviewFilter): boolean {
  if (filter === 'none') return status === undefined || status === 'no-reviews'
  return status === undefined || status === filter
}

export interface PullRequestListFacets {
  authors: string[]
  labels: string[]
}

/** The authors and labels the loaded rows have, for the filter menus. */
export function pullRequestListFacets(rows: readonly PullRequestRow[]): PullRequestListFacets {
  const sorted = (values: Iterable<string>) => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
  return {
    authors: sorted(rows.map((row) => row.pr.author)),
    labels: sorted(rows.flatMap((row) => row.pr.labels.map((label) => label.name))),
  }
}

/**
 * The one compact row the host notices fold into, or null when they show in
 * full. While rows show, the notices (offline, GitHub not connected, a failed
 * read) would push them off screen, so they fold behind a count, as desktop
 * reports a partial failure in a toast. With no rows they explain the empty
 * list, so they stay open.
 */
export function hostNoticesSummary(noticeCount: number, rowCount: number): string | null {
  if (noticeCount === 0 || rowCount === 0) return null
  return `${noticeCount} ${noticeCount === 1 ? 'host' : 'hosts'} could not be read`
}

/** The review state a row shows, changes requested first. */
export function pullRequestRowReviewStatus(pr: Pick<PullRequest, 'reviewStatus' | 'needsMyReview'>): { label: string; accessibleLabel: string; tone: 'danger' | 'success' | 'warning' | 'muted' } | null {
  if (pr.reviewStatus === 'changes-requested') return { label: 'Changes', accessibleLabel: 'Changes requested', tone: 'danger' }
  if (pr.reviewStatus === 'approved') return { label: 'Approved', accessibleLabel: 'Reviews approved', tone: 'success' }
  if (pr.needsMyReview) return { label: 'Your review', accessibleLabel: 'Your review requested', tone: 'warning' }
  if (pr.reviewStatus === 'review-required') return { label: 'Review', accessibleLabel: 'Review required', tone: 'muted' }
  return null
}

/** A label's color as `#rrggbb`, or null when the host sent no usable color. */
export function pullRequestLabelColor(color: string | null | undefined): string | null {
  const hex = color?.replace(/^#/, '')
  return hex && /^[\da-f]{6}$/i.test(hex) ? `#${hex}` : null
}
