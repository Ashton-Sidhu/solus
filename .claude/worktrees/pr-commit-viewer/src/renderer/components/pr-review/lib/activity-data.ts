// Private logic for the Activity overview: shaping GitHub diff hunks for the
// inline thread previews, and the initials shown in author/comment avatars.
// (Per-file +/- counts come from the provider-backed `prChangedFiles` handler.)

import type { PrCommit, PrConversationItem, ReviewThread } from '../../../../shared/providers'

/**
 * One entry in the activity timeline. The opened event is rendered separately as
 * a fixed first row (it always leads and isn't gated on `detail` loading), so it
 * isn't part of this union — these are the events that interleave by time. A
 * `commits` event holds a *consecutive* run of commits (nothing else happened
 * between them chronologically); a comment/thread breaks the run into groups.
 */
export type ActivityEvent =
  | { kind: 'commits'; ts: number; commits: PrCommit[] }
  | { kind: 'thread'; ts: number; thread: ReviewThread }
  | { kind: 'comment'; ts: number; comment: PrConversationItem }

/** Stable key for `{#each}` — first commit sha of a run, or thread/comment id. */
export function activityEventKey(event: ActivityEvent): string {
  if (event.kind === 'commits') return `commits:${event.commits[0].sha}`
  if (event.kind === 'thread') return event.thread.id
  return event.comment.id
}

/** Header-chip focus for the timeline: everything, conversation only, or commits only. */
export type ActivityFilter = 'all' | 'conversation' | 'commits'

/**
 * Narrow the timeline to the active filter. `unresolvedOnly` overrides `filter`
 * entirely and keeps only unresolved review threads; `'conversation'` keeps
 * threads plus top-level comments/reviews (everything but commit runs).
 */
export function filterActivityTimeline(
  events: ActivityEvent[],
  filter: ActivityFilter,
  unresolvedOnly: boolean,
): ActivityEvent[] {
  if (unresolvedOnly) return events.filter((e) => e.kind === 'thread' && !e.thread.isResolved)
  if (filter === 'conversation') return events.filter((e) => e.kind !== 'commits')
  if (filter === 'commits') return events.filter((e) => e.kind === 'commits')
  return events
}

/**
 * A review verdict worth promoting to a timeline milestone. Non-null only for
 * approvals and change requests — COMMENTED/DISMISSED reviews stay ordinary
 * avatar rows since their state carries no verdict.
 */
export function reviewMilestone(
  item: PrConversationItem,
): { headline: string; tone: 'positive' | 'negative' } | null {
  if (item.kind !== 'review') return null
  if (item.reviewState === 'APPROVED') return { headline: 'approved these changes', tone: 'positive' }
  if (item.reviewState === 'CHANGES_REQUESTED') return { headline: 'requested changes', tone: 'negative' }
  return null
}

export const COMMIT_PREVIEW_COUNT = 3

/**
 * Collapse a long commit run to its first few entries. Never hides a single
 * commit behind an expander — a run of 4 shows all 4 rather than "Show 1 more".
 */
export function commitRunPreview(
  commits: PrCommit[],
  expanded: boolean,
): { visible: PrCommit[]; hidden: number } {
  if (expanded || commits.length <= COMMIT_PREVIEW_COUNT + 1) return { visible: commits, hidden: 0 }
  return {
    visible: commits.slice(0, COMMIT_PREVIEW_COUNT),
    hidden: commits.length - COMMIT_PREVIEW_COUNT,
  }
}

/** Who authored a run of commits, deduped ("ashton", "ashton and 2 others"). */
export function commitRunAuthorLabel(commits: PrCommit[], fallback: string): string {
  const authors = [...new Set(commits.map((c) => c.author))].filter(Boolean)
  if (authors.length === 0) return fallback
  if (authors.length === 1) return authors[0]
  return `${authors[0]} and ${authors.length - 1} other${authors.length > 2 ? 's' : ''}`
}

/**
 * Merge pushed commits, review threads, and top-level conversation into one
 * chronologically-sorted timeline so they interleave by when they happened
 * rather than always showing commits-then-threads-then-comments. Adjacent
 * commits (with no thread/comment between them) collapse into a single
 * "added N commits" run; a comment or thread ends the run so two commits
 * followed by a comment render as a two-commit group, then the comment.
 */
export function buildActivityTimeline(
  commits: PrCommit[],
  threads: ReviewThread[],
  comments: PrConversationItem[],
): ActivityEvent[] {
  type Raw =
    | { kind: 'commit'; ts: number; commit: PrCommit }
    | { kind: 'thread'; ts: number; thread: ReviewThread }
    | { kind: 'comment'; ts: number; comment: PrConversationItem }
  const raw: Raw[] = []
  for (const commit of commits) {
    raw.push({ kind: 'commit', ts: new Date(commit.committedAt).getTime(), commit })
  }
  for (const thread of threads) {
    const ts = new Date(thread.comments[0]?.createdAt ?? 0).getTime()
    raw.push({ kind: 'thread', ts, thread })
  }
  for (const comment of comments) {
    raw.push({ kind: 'comment', ts: new Date(comment.createdAt).getTime(), comment })
  }
  raw.sort((a, b) => a.ts - b.ts)

  const events: ActivityEvent[] = []
  for (const item of raw) {
    if (item.kind === 'commit') {
      const last = events[events.length - 1]
      if (last?.kind === 'commits') {
        // Extend the current run; anchor its stamp to the latest commit in it.
        last.commits.push(item.commit)
        last.ts = item.ts
      } else {
        events.push({ kind: 'commits', ts: item.ts, commits: [item.commit] })
      }
    } else if (item.kind === 'thread') {
      events.push({ kind: 'thread', ts: item.ts, thread: item.thread })
    } else {
      events.push({ kind: 'comment', ts: item.ts, comment: item.comment })
    }
  }
  return events
}

/**
 * The minimal PR identity the Activity view needs to render. A full
 * `PrReviewContext` (the worktree-backed review pane) satisfies this
 * structurally, while the PRs list passes only the subset it has before a
 * worktree exists — the view fetches everything else from `detail`. Keeping the
 * required surface to `number`/`title` is what lets one component serve both.
 */
export interface PrActivityTarget {
  number: number
  title: string
  /** Remote host for a direct PR link; present in the full review pane. */
  host?: string
  /** Base repo owner for a direct PR link when `owner` is being used as author. */
  remoteOwner?: string
  /** Author login shown until `detail` loads (the list has it from the summary). */
  owner?: string
  /** Repo name for the `repo#number` meta chip; omitted in the list preview. */
  repo?: string
  /** Base branch for the meta line; falls back to `detail.baseRef`. */
  baseRef?: string
  /** Head branch for the meta line; falls back to `detail.headRef`. */
  headRef?: string
  /** Diff base for the review worktree; the files rail is loaded by PR number. */
  baseSha?: string
  /** New-comment anchor; falls back to `detail.headSha`. */
  headSha?: string
  /** Author avatar URL — rendered as a real image instead of initials. */
  authorAvatarUrl?: string
}

/**
 * Wrap a GitHub `diffHunk` (a bare `@@ … @@` fragment with no file headers) in a
 * minimal `diff --git` envelope so `@pierre/diffs`' patch parser accepts it and
 * renders the snippet with the same engine the Diff tab uses.
 */
export function hunkToPatch(filePath: string, hunk: string): string {
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${hunk}\n`
}

/** Up to two uppercase initials from a display name or login (`ashton-sidhu` → `AS`). */
export function initials(name: string): string {
  const parts = name.split(/[\s_./-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** `foo/bar/baz.ts` → `baz.ts`. */
export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/** Directory portion of a path, with a trailing slash (`foo/bar/baz.ts` → `foo/bar/`). */
export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i + 1) : ''
}
