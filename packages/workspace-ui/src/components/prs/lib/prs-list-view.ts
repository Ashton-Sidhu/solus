/**
 * Maps `PullRequest` records into the shared list-page grammar ("List
 * pages" spec, Part B — Pull requests). Pure and non-reactive: PrsPage reads
 * these from `$derived`.
 *
 * Tasks and Pull requests are one page built twice. Everything about how a row
 * is *drawn* lives in `components/ui/list-page`; this file declares only what
 * belongs to Pull requests — its groups, its identifier width, its chips
 * (branch, checks), its meta column (diff size) and its verbs.
 */
import {
  GitMerge as GitMergeIcon,
  GitPullRequest as GitPullRequestIcon,
  GitPullRequestClosed as GitPullRequestClosedIcon,
  GitPullRequestDraft as GitPullRequestDraftIcon,
  TriangleAlert as TriangleAlertIcon,
} from '@lucide/svelte'
import type { PullRequest } from '@solus/contracts/providers'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PrGuideStatus } from '@solus/contracts/review'
import { z } from 'zod'
import {
  absoluteTime,
  compactRelativeTime,
  personFrom,
  type ListChecksSpec,
  type ListGroupSpec,
  type ListIcon,
  type ListRevealSpec,
  type ListRowSpec,
  type ListTint,
} from '../../ui/list-page/list-page'
import { Clock, LoaderCircle, CircleAlert, CircleMinus, BookOpen, BookOpenCheck } from '@lucide/svelte'
import { relativeTime, type PrSortMode } from './pr-utils'
import { hasMergeConflicts } from '../../pr-review/lib/merge-readiness'
import { PR_STATUS_TONE } from './pr-row-styles'

/** One of the host's labels, as the row's facts line draws it: the name on a
 *  pastel of the host's colour. */
export interface PrRowLabel {
  name: string
  /** Hex without the `#`, as GitHub reports it. */
  color: string
}

/** A review verdict worth a mark on the row. "Review required" is not one:
 *  it is the resting state of an open PR, so the row says nothing. */
export type PrVerdict = 'approved' | 'changes-requested'

/**
 * The pull request row. The shared grammar carries the title, ident, people,
 * churn and checks; what a PR row says beyond that — which repository, whose
 * labels, and the lifecycle glyph that leads the row — is declared here.
 */
export interface PrRowSpec extends ListRowSpec {
  status: PrStatusKey
  verdict: PrVerdict | null
  /** `owner/repo`, so a cross-project list says where each row lives. */
  repo: string
  /** The project's own name, where the list spans every project. The row
   *  shows it in place of the repository, which stays its tooltip. */
  project: string | null
  labels: PrRowLabel[]
  /** Labels past the three drawn, as a `+n` after them. */
  moreLabels: number
  /** `9h ago` — the wide row has room for the word the 32px slot does not. */
  updated: string
}

/** Two lines at every width: a title, then a line of facts that truncates. A
 *  fixed number because the row sits in a virtualiser, which is told a height
 *  before layout. `PrListRow.svelte` states the same 62. */
export const PR_LIST_ROW_HEIGHT = 62

/** The most rows the list pages to. Past it the page asks for a
 *  narrower search: a list that long is searched, not scrolled. */
export const PR_LIST_LOAD_CAP = 500

const LABELS_SHOWN = 3

export interface PrStatusGlyph {
  icon: ListIcon
  label: string
  /** The state's tone as text-colour classes, light and dark (`PR_STATUS_TONE`). */
  toneClass: string
}

/** The lifecycle state as the glyph that leads the row, the way a code host
 *  draws it: one shape and one tone per state, no word. */
export function prStatusGlyph(status: PrStatusKey): PrStatusGlyph {
  switch (status) {
    case 'open':
      return { icon: GitPullRequestIcon, label: 'Open', toneClass: PR_STATUS_TONE.open }
    case 'draft':
      return { icon: GitPullRequestDraftIcon, label: 'Draft', toneClass: PR_STATUS_TONE.draft }
    case 'merged':
      return { icon: GitMergeIcon, label: 'Merged', toneClass: PR_STATUS_TONE.merged }
    case 'closed':
      return { icon: GitPullRequestClosedIcon, label: 'Closed', toneClass: PR_STATUS_TONE.closed }
  }
}

/** Per-PR facts the page has loaded separately from the list fetch. Both take
 *  the full record, not a bare number — a workspace-wide list can hold the
 *  same PR number from two different repos, so only the record disambiguates. */
export interface PrRowContext {
  checks: (pr: PullRequest) => PrChecksSummary | undefined
  guideStatus?: (pr: PullRequest) => PrGuideStatus | undefined
  /** Whether the viewer authored it. Drives the Authored section. */
  isMine: (pr: PullRequest) => boolean
  /** Whether the viewer is asked to review it. Absent means the host's own
   *  `needsMyReview` flag is the whole answer. */
  isReviewRequested?: (pr: PullRequest) => boolean
}

function guideChips(pr: PullRequest, ctx: PrRowContext): ListRowSpec['chips'] {
  const status = ctx.guideStatus?.(pr)
  if (!status) return []
  const states = {
    ready: { label: 'Review guide available', statusIcon: undefined, tint: 'success' },
    outdated: { label: 'Review guide outdated', statusIcon: CircleAlert, tint: 'warning' },
    queued: { label: 'Review guide queued', statusIcon: Clock, tint: 'neutral' },
    generating: { label: 'Generating review guide', statusIcon: LoaderCircle, tint: 'info' },
    failed: { label: 'Review guide generation failed', statusIcon: CircleAlert, tint: 'failure' },
    cancelled: { label: 'Review guide generation cancelled', statusIcon: CircleMinus, tint: 'neutral' },
  } satisfies Record<PrGuideStatus, { label: string; statusIcon: ListIcon | undefined; tint: ListTint }>
  return [{ ...states[status], icon: status === 'ready' ? BookOpenCheck : BookOpen, iconOnly: true, spinning: status === 'generating' }]

}

/** A conflict is a fact of an open PR that neither the group nor the state
 *  glyph carries, so it is the one state that is always a chip. */
function conflictChips(pr: PullRequest): ListRowSpec['chips'] {
  return hasMergeConflicts(pr) ? [{ label: 'Conflicts', tint: 'warning', icon: TriangleAlertIcon }] : []
}

function rowLabels(pr: PullRequest): Pick<PrRowSpec, 'labels' | 'moreLabels'> {
  return {
    labels: pr.labels.slice(0, LABELS_SHOWN).map(({ name, color }) => ({ name, color })),
    moreLabels: Math.max(0, pr.labels.length - LABELS_SHOWN),
  }
}

/**
 * The lifecycle states the list can be filtered to. "Awaiting your review" is
 * not one of them: it is a group, not a state — a PR is open whether or not it
 * happens to be waiting on you — and the Yours chip already cuts that axis.
 */
export type PrStatusKey = 'open' | 'draft' | 'merged' | 'closed'

export const PR_STATUS_OPTIONS: { value: PrStatusKey; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'draft', label: 'Draft' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
]

/** What the list opens on: what can still be landed. */
export const OPEN_PR_STATUS_KEYS: PrStatusKey[] = ['open', 'draft']

const LEGACY_REVIEWER_LOGIN = z.string()

export function prStatusOf(pr: PullRequest): PrStatusKey {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  return pr.draft ? 'draft' : 'open'
}

/**
 * The *fetch* scope a status selection needs. The host pages open and closed
 * pull requests separately, so asking for a merged PR is not a display filter —
 * it has to widen what the page loads before it can hide anything.
 */
export function prFetchScope(statuses: readonly string[]): 'open' | 'closed' | 'all' {
  const wantsOpen = statuses.includes('open') || statuses.includes('draft')
  const wantsClosed = statuses.includes('merged') || statuses.includes('closed')
  if (wantsOpen && wantsClosed) return 'all'
  return wantsClosed ? 'closed' : 'open'
}

const BRANCH_PRINTS_WHOLE = 26
const BRANCH_HEAD = 12
const BRANCH_TAIL = 9

/**
 * Agent-authored branches are long and near-identical, so the middle is what
 * they share and the tail is what tells them apart — the ellipsis goes in the
 * middle rather than at the end. Short refs print whole; this slot is not a
 * column, so there is nothing to pad to.
 */
export function shortBranch(ref: string): string {
  if (ref.length <= BRANCH_PRINTS_WHOLE) return ref
  return `${ref.slice(0, BRANCH_HEAD)}…${ref.slice(-BRANCH_TAIL)}`
}

/**
 * Slot 4 — the branch, and the parent it is stacked on. Held back until the row
 * is hovered, focused or selected: it is a fact you need once you have chosen a
 * row, not to choose one, and at rest it would spend the same width on every
 * row while the title is what you are scanning.
 */
function revealFor(pr: PullRequest, stackParent: number | null): ListRevealSpec | undefined {
  if (!pr.headRef && stackParent === null) return undefined
  return {
    label: pr.headRef ? shortBranch(pr.headRef) : '',
    title: pr.headRef,
    lead: stackParent === null ? undefined : `stacked on #${stackParent}`,
  }
}

/**
 * Slot 5 — the check state, in words. A stale result is not this head's, and a
 * PR with no checks configured has nothing to report, so both hold the slot in
 * silence rather than asserting anything.
 */
function checksFor(pr: PullRequest, checks: PrChecksSummary | undefined): ListChecksSpec {
  if (!checks || checks.headSha !== pr.headSha) return { state: 'none', label: '' }
  if (checks.state === 'failing') {
    const failing = checks.required.filter((check) => check.conclusion === 'failure').length
    return {
      state: 'failing',
      label: failing > 0 ? `${failing} check${failing === 1 ? '' : 's'} failing` : 'Checks failing',
    }
  }
  if (checks.state === 'passing') return { state: 'passing', label: 'Checks passing' }
  if (checks.state === 'pending') return { state: 'pending', label: 'Checks running' }
  return { state: 'none', label: '' }
}

export function prRow(
  pr: PullRequest,
  ctx: PrRowContext,
  now: number,
  stackParent: number | null = null,
  /** Row identity. Defaults to the bare number — safe for a single-repo list;
   *  a cross-repo list must pass a qualified key or two repos' identical
   *  numbers collide into one row. */
  key: string = String(pr.number),
  /** The project's name, where the list spans every project. */
  project: string | null = null,
): PrRowSpec {
  // A mounted PR store can still hold the former string-only shape during a
  // development hot reload. Keep those rows usable until the next host fetch.
  const reviewers = (pr.requestedReviewers ?? []).map((reviewer) => {
    const legacyLogin = LEGACY_REVIEWER_LOGIN.safeParse(reviewer)
    return legacyLogin.success
      ? personFrom(legacyLogin.data)
      : personFrom(reviewer.login, undefined, reviewer.avatarUrl)
  })
  return {
    key,
    ident: `#${pr.number}`,
    title: pr.title,
    status: prStatusOf(pr),
    verdict: pr.reviewStatus === 'approved' || pr.reviewStatus === 'changes-requested' ? pr.reviewStatus : null,
    repo: `${pr.baseRepo.owner}/${pr.baseRepo.repo}`,
    project,
    ...rowLabels(pr),
    updated: relativeTime(pr.updatedAt, now),
    // The state leads the row as a glyph, so the chips are only what needs
    // saying beyond it; the branch stays a hover reveal so the title is still
    // the only elastic thing in the middle of the row.
    chips: [...conflictChips(pr), ...guideChips(pr, ctx)],
    reveal: revealFor(pr, stackParent),
    checks: checksFor(pr, ctx.checks(pr)),
    meta: '',
    // 0 / 0 is what a listing without line counts reports, not an empty
    // change, so it says nothing rather than a false "+0 −0".
    churn: pr.additions + pr.deletions > 0 ? { additions: pr.additions, deletions: pr.deletions } : undefined,
    // Slot 1 is the author; slots 7 are whoever else is on the hook for it.
    people: [personFrom(pr.author, undefined, pr.authorAvatarUrl), ...reviewers],
    time: compactRelativeTime(pr.updatedAt, now),
    timeTitle: absoluteTime(pr.updatedAt),
  }
}

/**
 * The list's sections, partitioned by involvement: what you wrote, then
 * what you are asked to review, then everything else. A pull request that is
 * both yours and waiting on your review is yours — it is the work you own.
 * Order inside each section is the order handed in, so the chosen sort holds
 * within every section while Authored stays first. Empty sections are dropped.
 */
export type PrSectionKey = 'authored' | 'review-requested' | 'others' | 'all'

export interface PrSection {
  key: PrSectionKey
  label: string
  prs: PullRequest[]
}

const SECTION_LABELS = {
  authored: 'Authored',
  'review-requested': 'Review requested',
  others: 'Others',
} satisfies Record<Exclude<PrSectionKey, 'all'>, string>

/** Whether the viewer wrote this pull request. No login means not the viewer's:
 *  a PR is never labelled yours on a guess. */
export function isAuthoredBy(pr: PullRequest, viewerLogin: string | null): boolean {
  return !!viewerLogin && pr.author.toLowerCase() === viewerLogin.toLowerCase()
}

/** Whether the host lists the viewer as a requested reviewer on this pull request. */
export function isReviewRequestedFrom(pr: PullRequest, viewerLogin: string | null): boolean {
  const login = viewerLogin?.toLowerCase()
  return !!login && !!pr.requestedReviewers?.some((reviewer) => reviewer.login.toLowerCase() === login)
}

export function prSections(prs: readonly PullRequest[], ctx: Pick<PrRowContext, 'isMine' | 'isReviewRequested'>): PrSection[] {
  const authored: PullRequest[] = []
  const reviewRequested: PullRequest[] = []
  const others: PullRequest[] = []
  for (const pr of prs) {
    if (ctx.isMine(pr)) authored.push(pr)
    else if (pr.needsMyReview || ctx.isReviewRequested?.(pr)) reviewRequested.push(pr)
    else others.push(pr)
  }
  const sections: PrSection[] = [
    { key: 'authored', label: SECTION_LABELS.authored, prs: authored },
    { key: 'review-requested', label: SECTION_LABELS['review-requested'], prs: reviewRequested },
    { key: 'others', label: SECTION_LABELS.others, prs: others },
  ]
  return sections.filter((section) => section.prs.length > 0)
}

/**
 * Whether the list is split into sections. Only the unnarrowed list is: a
 * search is ordered by how well each row answers it, and a list already
 * narrowed to one involvement would put every row in one section anyway.
 */
export function showsPrSections(involvement: PrListView['involvement'], query: string): boolean {
  return involvement === 'all' && query.trim().length === 0
}

/** The list as one flat group — the shape a search or a narrowed list takes. */
export function flatPrSection(prs: PullRequest[]): PrSection[] {
  return prs.length > 0 ? [{ key: 'all', label: 'Pull requests', prs }] : []
}

/** The sections as the shared list grammar's groups. */
export function prGroups(
  sections: PrSection[],
  ctx: PrRowContext,
  now: number,
  /** Row identity override — see `prRow`. */
  keyFor?: (pr: PullRequest) => string,
  /** The project a row belongs to, where the list spans every project. */
  projectOf?: (pr: PullRequest) => string | null,
): ListGroupSpec<PrRowSpec>[] {
  return sections.map((section) => ({
    key: section.key,
    label: section.label,
    rows: section.prs.map((pr) => prRow(pr, ctx, now, null, keyFor?.(pr), projectOf?.(pr) ?? null)),
  }))
}

/**
 * How the list was left: the query, the narrowing, and the reading position.
 *
 * `PrsPage` owns this and nothing else reads it. It used to live on a
 * per-project record in `PrsStore`, which read as durable state about a
 * project — but it is discarded whenever the project changes, so the per-project
 * keying never did anything. It is page state, and the page keeps it.
 */
export interface PrListView {
  guide: 'all' | 'has-guide'
  query: string
  /** The lifecycle states the list is showing. Also decides the *fetch*
   *  scope, since the server pages open and closed separately. */
  statusKeys: string[]
  sortMode: PrSortMode
  involvement: 'all' | 'created' | 'assigned' | 'review-requested'
  author: string | null
  label: string | null
  draft: 'all' | 'ready' | 'draft'
  review: 'all' | 'approved' | 'changes-requested' | 'review-required' | 'no-reviews'
  checks: 'all' | 'passing' | 'pending' | 'failing'
  collapsedGroups: Record<string, boolean>
  selectedNumber: number | null
  scrollTop: number
  /** The pull request showing in the page's detail panel, or `null` while the
   *  list has the page to itself. Highlighting a row with the arrow keys moves
   *  `selectedNumber` only; opening one moves both. */
  openNumber: number | null
  /** The panel covers the list instead of sitting beside it. */
  panelFullScreen: boolean
}

export function emptyListView(): PrListView {
  return {
    guide: 'all',
    query: '',
    statusKeys: [...OPEN_PR_STATUS_KEYS],
    sortMode: 'ready',
    involvement: 'all',
    author: null,
    label: null,
    draft: 'all',
    review: 'all',
    checks: 'all',
    collapsedGroups: {},
    selectedNumber: null,
    scrollTop: 0,
    openNumber: null,
    panelFullScreen: false,
  }
}
