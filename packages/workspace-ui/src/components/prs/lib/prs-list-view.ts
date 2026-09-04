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
  checksChip,
  compactCount,
  compactRelativeTime,
  personFrom,
  type InboxGroupSpec,
  type ListChecksSpec,
  type ListGroupSpec,
  type ListIcon,
  type ListRevealSpec,
  type ListRowSpec,
  type ListTint,
} from '../../ui/list-page/list-page'
import { relativeTime } from './pr-utils'

/** One of the host's labels, as the row's facts line draws it: the name on a
 *  pastel of the host's colour. */
export interface PrRowLabel {
  name: string
  /** Hex without the `#`, as GitHub reports it. */
  color: string
}

/**
 * The pull request row. The shared grammar carries the title, ident, people,
 * churn and checks; what a PR row says beyond that — which repository, whose
 * labels, and the lifecycle glyph that leads the row — is declared here.
 */
export interface PrRowSpec extends ListRowSpec {
  status: PrStatusKey
  /** `owner/repo`, so a cross-project list says where each row lives. */
  repo: string
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

const LABELS_SHOWN = 3

export interface PrStatusGlyph {
  icon: ListIcon
  label: string
  /** A CSS colour: the state's tone mixed toward the foreground so it holds in
   *  both light and dark mode. */
  color: string
}

/** The lifecycle state as the glyph that leads the row, the way a code host
 *  draws it: one shape and one tone per state, no word. */
export function prStatusGlyph(status: PrStatusKey): PrStatusGlyph {
  switch (status) {
    case 'open':
      return {
        icon: GitPullRequestIcon,
        label: 'Open',
        color: 'color-mix(in oklch, var(--success) 72%, var(--foreground))',
      }
    case 'draft':
      return { icon: GitPullRequestDraftIcon, label: 'Draft', color: 'var(--muted-foreground)' }
    case 'merged':
      return { icon: GitMergeIcon, label: 'Merged', color: 'var(--review)' }
    case 'closed':
      return {
        icon: GitPullRequestClosedIcon,
        label: 'Closed',
        color: 'color-mix(in oklch, var(--failure) 70%, var(--foreground))',
      }
  }
}

/** Per-PR facts the page has loaded separately from the list fetch. Both take
 *  the full record, not a bare number — a workspace-wide list can hold the
 *  same PR number from two different repos, so only the record disambiguates. */
export interface PrRowContext {
  checks: (pr: PullRequest) => PrChecksSummary | undefined
  guideStatus?: (pr: PullRequest) => PrGuideStatus | undefined
  /** Whether the viewer authored it. Drives the "Yours" filter and the inbox split. */
  isMine: (pr: PullRequest) => boolean
}

function guideChips(pr: PullRequest, ctx: PrRowContext): ListRowSpec['chips'] {
  const status = ctx.guideStatus?.(pr)
  if (status === 'queued') return [{ label: 'Guide queued', tint: 'running' }]
  if (status === 'generating') return [{ label: 'Generating guide', tint: 'running' }]
  return []
}

/** The host has finished computing the merge and found it cannot happen.
 *  `mergeable: null` is still computing, so it says nothing. */
function hasMergeConflicts(pr: PullRequest): boolean {
  return pr.state === 'open' && (pr.mergeStateStatus === 'dirty' || pr.mergeable === false)
}

/** A conflict is a fact of an open PR that neither the group nor the state
 *  glyph carries, so it is the one state that is always a chip. */
function conflictChips(pr: PullRequest): ListRowSpec['chips'] {
  return hasMergeConflicts(pr) ? [{ label: 'Conflicts', tint: 'warning', icon: TriangleAlertIcon }] : []
}

/**
 * The lifecycle state as a chip, for the inbox row: its groups are about you
 * rather than about lifecycle, and it has no leading glyph, so the state has
 * to be said in words there.
 */
function stateChips(pr: PullRequest): ListRowSpec['chips'] {
  const status = prStatusOf(pr)
  const glyph = prStatusGlyph(status)
  return [{ label: glyph.label, tint: STATE_CHIP_TINT[status], icon: glyph.icon }, ...conflictChips(pr)]
}

/** Draft is the one state that is not news, so it is the one that stays neutral. */
const STATE_CHIP_TINT: Record<PrStatusKey, ListTint | undefined> = {
  open: 'success',
  draft: undefined,
  merged: 'primary',
  closed: 'failure',
}

function rowLabels(pr: PullRequest): Pick<PrRowSpec, 'labels' | 'moreLabels'> {
  return {
    labels: pr.labels.slice(0, LABELS_SHOWN).map(({ name, color }) => ({ name, color })),
    moreLabels: Math.max(0, pr.labels.length - LABELS_SHOWN),
  }
}

/**
 * Lifecycle order, most-wants-you-first. "Awaiting your review" is deliberately
 * above "Open": the first group is the reason to be on this page at all.
 */
type PrGroupKey = 'review' | 'open' | 'draft' | 'merged' | 'closed'

function groupOf(pr: PullRequest, ctx: PrRowContext): PrGroupKey {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.draft) return 'draft'
  if (pr.needsMyReview && !ctx.isMine(pr)) return 'review'
  return 'open'
}

const GROUP_LABELS = {
  review: 'Awaiting your review',
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
} satisfies Record<PrGroupKey, string>

const GROUP_ORDER: PrGroupKey[] = ['review', 'open', 'draft', 'merged', 'closed']

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

/** `+248 −96`, compacted past a thousand so the column can't be pushed wide by
 *  one enormous PR. The list row draws the same two numbers itself, coloured;
 *  this is the form the inbox's one-line context needs. */
export function diffSize(pr: PullRequest): string {
  return `+${compactCount(pr.additions)} −${compactCount(pr.deletions)}`
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
    repo: `${pr.baseRepo.owner}/${pr.baseRepo.repo}`,
    ...rowLabels(pr),
    updated: relativeTime(pr.updatedAt, now),
    // The state leads the row as a glyph, so the chips are only what needs
    // saying beyond it; the branch stays a hover reveal so the title is still
    // the only elastic thing in the middle of the row.
    chips: [...conflictChips(pr), ...guideChips(pr, ctx)],
    reveal: revealFor(pr, stackParent),
    checks: checksFor(pr, ctx.checks(pr)),
    meta: '',
    churn: { additions: pr.additions, deletions: pr.deletions },
    // Slot 1 is the author; slots 7 are whoever else is on the hook for it.
    people: [personFrom(pr.author, undefined, pr.authorAvatarUrl), ...reviewers],
    time: compactRelativeTime(pr.updatedAt, now),
    timeTitle: absoluteTime(pr.updatedAt),
  }
}

/** The grouped global list. Empty groups are dropped rather than shown at zero. */
export function prGroups(
  prs: PullRequest[],
  ctx: PrRowContext,
  now: number,
  /** Which PR each row is stacked on, when stacks are enabled. A function
   *  rather than a `Map<number, number>` because a cross-repo list cannot key
   *  a lookup by bare PR number. */
  stackParentOf?: (pr: PullRequest) => number | null,
  /** Row identity override — see `prRow`. */
  keyFor?: (pr: PullRequest) => string,
): ListGroupSpec<PrRowSpec>[] {
  return GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key],
    rows: prs
      .filter((pr) => groupOf(pr, ctx) === key)
      .map((pr) => prRow(pr, ctx, now, stackParentOf?.(pr) ?? null, keyFor?.(pr))),
  })).filter((group) => group.rows.length > 0)
}

export interface PrInboxActions {
  review: (pr: PullRequest) => void
  open: (pr: PullRequest) => void
  openExternal: (pr: PullRequest) => void
}

/**
 * The personal inbox. The global list is for looking; this is for finishing.
 *
 * Three groups, derived from what the list fetch already knows: what is waiting
 * on your review, what is waiting on *you* to move your own PR along (failing
 * checks, requested changes), and what has landed. There is no mentions group —
 * review-comment mentions need a notifications fetch the PR list doesn't make.
 *
 * The page's status filter reaches in here too, so the queue holds only the
 * states asked for. Landed work is off by default: an inbox is a list of
 * decisions, and a merged PR is not one.
 */
export function prInboxGroups(
  prs: PullRequest[],
  ctx: PrRowContext,
  now: number,
  actions: PrInboxActions,
  statuses: Set<string>,
  /** Row identity override — see `prRow`. */
  keyFor?: (pr: PullRequest) => string,
): InboxGroupSpec[] {
  const groups: InboxGroupSpec[] = []
  const updated = (pr: PullRequest) => Date.parse(pr.updatedAt) || 0
  const shown = prs.filter((pr) => statuses.has(prStatusOf(pr)))

  const needsYou = shown.filter(
    (pr) => pr.state === 'open' && !pr.draft && pr.needsMyReview && !ctx.isMine(pr),
  )
  if (needsYou.length > 0) {
    groups.push({
      key: 'needs',
      label: 'Needs you',
      note: 'oldest first',
      accent: true,
      rows: [...needsYou]
        .sort((a, b) => updated(a) - updated(b))
        .map((pr) => ({
          ...inboxRowBase(pr, ctx, now, keyFor),
          title:
            pr.reviewAttention === 'assigned'
              ? `Assigned to you: ${pr.title}`
              : `Review requested: ${pr.title}`,
          context: reviewContext(pr, ctx),
          unread: true,
          primary: { label: 'Review', shortcut: '⏎', run: () => actions.review(pr) },
          secondary: { label: 'Open on host', run: () => actions.openExternal(pr) },
        })),
    })
  }

  // Your open pull requests belong in the personal inbox even when they are
  // healthy. The queue spans projects, so this is the one place to see what you
  // own without opening each repository first.
  const yours = shown.filter((pr) => pr.state === 'open' && ctx.isMine(pr))
  if (yours.length > 0) {
    groups.push({
      key: 'waiting',
      label: 'Your pull requests',
      note: 'newest first',
      rows: [...yours]
        .sort((a, b) => updated(b) - updated(a))
        .map((pr) => ({
          ...inboxRowBase(pr, ctx, now, keyFor),
          context: yourPrContext(pr, ctx),
          unread: false,
          primary: { label: 'Open', shortcut: '⏎', run: () => actions.open(pr) },
        })),
    })
  }

  const landed = shown.filter((pr) => pr.state === 'merged' || pr.state === 'closed')
  if (landed.length > 0) {
    groups.push({
      key: 'done',
      label: 'Done',
      note: 'newest first',
      rows: [...landed]
        .sort((a, b) => updated(b) - updated(a))
        .map((pr) => ({
          ...inboxRowBase(pr, ctx, now, keyFor),
          context: `${pr.state === 'merged' ? 'Merged' : 'Closed'} · ${diffSize(pr)}${pr.headRef ? ` · ${pr.headRef}` : ''}`,
          unread: false,
        })),
    })
  }

  return groups
}

/** The lifecycle state rides as a chip, so the line only names the failing
 *  check — the one fact the chip's count cannot carry. */
function yourPrContext(pr: PullRequest, ctx: PrRowContext): string {
  const checks = ctx.checks(pr)
  const parts = ['Your PR']
  if (checks?.headSha === pr.headSha && checks.state === 'failing') parts.push(failingContext(checks))
  if (pr.headRef) parts.push(pr.headRef)
  return parts.join(' · ')
}

function inboxRowBase(
  pr: PullRequest,
  ctx: PrRowContext,
  now: number,
  keyFor?: (pr: PullRequest) => string,
) {
  return {
    key: keyFor?.(pr) ?? String(pr.number),
    ident: `#${pr.number}`,
    title: pr.title,
    context: '',
    actor: personFrom(pr.author, undefined, pr.authorAvatarUrl),
    time: compactRelativeTime(pr.updatedAt, now),
    timeTitle: absoluteTime(pr.updatedAt),
    unread: false,
    chips: [...stateChips(pr), ...inboxChecksChips(pr, ctx), ...guideChips(pr, ctx)],
  }
}

/** The inbox row has no checks slot, so the same fact rides as a chip. */
function inboxChecksChips(pr: PullRequest, ctx: PrRowContext): ListRowSpec['chips'] {
  const chip = checksChip(checksFor(pr, ctx.checks(pr)))
  return chip ? [chip] : []
}

function reviewContext(pr: PullRequest, ctx: PrRowContext): string {
  const parts: string[] = []
  if (pr.headRef) parts.push(pr.headRef)
  parts.push(diffSize(pr))
  const checks = ctx.checks(pr)
  if (checks && checks.headSha === pr.headSha && checks.state === 'failing') {
    parts.push(failingContext(checks))
  }
  if (pr.effort) parts.push(`≈ ${pr.effort.minutes} min`)
  return parts.join(' · ')
}

function failingContext(checks: PrChecksSummary | undefined): string {
  if (!checks) return 'checks failing'
  const failing = checks.required.filter((check) => check.conclusion === 'failure')
  if (failing.length === 0) return 'checks failing'
  if (failing.length === 1) return `${failing[0].name} failing`
  return `${failing.length} checks failing`
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
  query: string
  /** The lifecycle states the list and the inbox are showing. Also decides the
   *  *fetch* scope, since the server pages open and closed separately. */
  statusKeys: string[]
  sortMode: 'updated' | 'created' | 'effort'
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
    query: '',
    statusKeys: [...OPEN_PR_STATUS_KEYS],
    sortMode: 'created',
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
