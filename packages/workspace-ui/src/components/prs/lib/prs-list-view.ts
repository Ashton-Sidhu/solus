/**
 * Maps `PullRequestSummary` records into the shared list-page grammar ("List
 * pages" spec, Part B — Pull requests). Pure and non-reactive: PrsPage reads
 * these from `$derived`.
 *
 * Tasks and Pull requests are one page built twice. Everything about how a row
 * is *drawn* lives in `components/ui/list-page`; this file declares only what
 * belongs to Pull requests — its groups, its identifier width, its chips
 * (branch, checks), its meta column (diff size) and its verbs.
 */
import type { PullRequestSummary } from '@solus/contracts/providers'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import {
  absoluteTime,
  compactCount,
  compactRelativeTime,
  personFrom,
  type InboxGroupSpec,
  type ListChecksSpec,
  type ListGroupSpec,
  type ListRevealSpec,
  type ListRowSpec,
} from '../../ui/list-page/list-page'

/** Per-PR facts the page has loaded separately from the list fetch. Both take
 *  the full record, not a bare number — a workspace-wide list can hold the
 *  same PR number from two different repos, so only the record disambiguates. */
export interface PrRowContext {
  checks: (pr: PullRequestSummary) => PrChecksSummary | undefined
  /** Whether the viewer authored it. Drives the "Yours" filter and the inbox split. */
  isMine: (pr: PullRequestSummary) => boolean
}

/**
 * Lifecycle order, most-wants-you-first. "Awaiting your review" is deliberately
 * above "Open": the first group is the reason to be on this page at all.
 */
type PrGroupKey = 'review' | 'open' | 'draft' | 'merged' | 'closed'

function groupOf(pr: PullRequestSummary, ctx: PrRowContext): PrGroupKey {
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

export function prStatusOf(pr: PullRequestSummary): PrStatusKey {
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
export function diffSize(pr: PullRequestSummary): string {
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
function revealFor(pr: PullRequestSummary, stackParent: number | null): ListRevealSpec | undefined {
  if (!pr.headRef && stackParent === null) return undefined
  return {
    label: pr.headRef ? shortBranch(pr.headRef) : '',
    title: pr.headRef,
    lead: stackParent === null ? undefined : `stacked on #${stackParent}`,
  }
}

/**
 * Slot 5 — a check state, but only when it has something to say. Passing gets a
 * glyph and no words; failing gets words. Pending resolves on its own and stale
 * results are not the PR's, so both hold the slot in silence rather than
 * asserting anything.
 */
function checksFor(pr: PullRequestSummary, checks: PrChecksSummary | undefined): ListChecksSpec {
  if (!checks || checks.headSha !== pr.headSha) return { state: 'none', label: '' }
  if (checks.state === 'failing') {
    const failing = checks.required.filter((check) => check.conclusion === 'failure').length
    return {
      state: 'failing',
      label: failing > 0 ? `${failing} check${failing === 1 ? '' : 's'} failing` : 'checks failing',
    }
  }
  if (checks.state === 'passing') return { state: 'passing', label: 'Checks passing' }
  return { state: 'none', label: '' }
}

export function prRow(
  pr: PullRequestSummary,
  ctx: PrRowContext,
  now: number,
  stackParent: number | null = null,
  /** Row identity. Defaults to the bare number — safe for a single-repo list;
   *  a cross-repo list must pass a qualified key or two repos' identical
   *  numbers collide into one row. */
  key: string = String(pr.number),
): ListRowSpec {
  const reviewers = (pr.requestedReviewers ?? []).map((login) => personFrom(login))
  return {
    key,
    ident: `#${pr.number}`,
    title: pr.title,
    // Nothing sits between the number and the trailing metrics at rest, so the
    // title is the only thing competing for the middle of the row.
    chips: [],
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
  prs: PullRequestSummary[],
  ctx: PrRowContext,
  now: number,
  /** Which PR each row is stacked on, when stacks are enabled. A function
   *  rather than a `Map<number, number>` because a cross-repo list cannot key
   *  a lookup by bare PR number. */
  stackParentOf?: (pr: PullRequestSummary) => number | null,
  /** Row identity override — see `prRow`. */
  keyFor?: (pr: PullRequestSummary) => string,
): ListGroupSpec[] {
  return GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key],
    rows: prs
      .filter((pr) => groupOf(pr, ctx) === key)
      .map((pr) => prRow(pr, ctx, now, stackParentOf?.(pr) ?? null, keyFor?.(pr))),
  })).filter((group) => group.rows.length > 0)
}

export interface PrInboxActions {
  review: (pr: PullRequestSummary) => void
  open: (pr: PullRequestSummary) => void
  openExternal: (pr: PullRequestSummary) => void
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
  prs: PullRequestSummary[],
  ctx: PrRowContext,
  now: number,
  actions: PrInboxActions,
  statuses: Set<string>,
  /** Row identity override — see `prRow`. */
  keyFor?: (pr: PullRequestSummary) => string,
): InboxGroupSpec[] {
  const groups: InboxGroupSpec[] = []
  const updated = (pr: PullRequestSummary) => Date.parse(pr.updatedAt) || 0
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
          ...inboxRowBase(pr, now, keyFor),
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

  // Your own open PRs whose checks are red — nothing else is going to move them.
  const yoursBlocked = shown.filter((pr) => {
    if (pr.state !== 'open' || !ctx.isMine(pr)) return false
    const checks = ctx.checks(pr)
    return !!checks && checks.headSha === pr.headSha && checks.state === 'failing'
  })
  if (yoursBlocked.length > 0) {
    groups.push({
      key: 'waiting',
      label: 'Waiting on you',
      note: 'checks failing',
      rows: [...yoursBlocked]
        .sort((a, b) => updated(a) - updated(b))
        .map((pr) => ({
          ...inboxRowBase(pr, now, keyFor),
          context: `Your PR · ${failingContext(ctx.checks(pr))}${pr.headRef ? ` · ${pr.headRef}` : ''}`,
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
          ...inboxRowBase(pr, now, keyFor),
          context: `${pr.state === 'merged' ? 'Merged' : 'Closed'} · ${diffSize(pr)}${pr.headRef ? ` · ${pr.headRef}` : ''}`,
          unread: false,
        })),
    })
  }

  return groups
}

function inboxRowBase(pr: PullRequestSummary, now: number, keyFor?: (pr: PullRequestSummary) => string) {
  return {
    key: keyFor?.(pr) ?? String(pr.number),
    ident: `#${pr.number}`,
    title: pr.title,
    context: '',
    actor: personFrom(pr.author, undefined, pr.authorAvatarUrl),
    time: compactRelativeTime(pr.updatedAt, now),
    timeTitle: absoluteTime(pr.updatedAt),
    unread: false,
    chips: [],
  }
}

function reviewContext(pr: PullRequestSummary, ctx: PrRowContext): string {
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
