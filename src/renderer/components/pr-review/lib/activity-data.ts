// Private logic for the Activity overview: shaping GitHub diff hunks for the
// inline thread previews, and the initials shown in author/comment avatars.
// (Per-file +/- counts come from the `prChangedFiles` numstat handler.)

import type { PrCommit, ReviewThread } from '../../../../shared/providers'

/** A comment posted from this session's composer (see ActivityFeed's `posted`). */
export interface PostedComment {
  id: string
  author: string
  body: string
  /** Epoch ms — already the client clock, so it sorts directly. */
  ts: number
}

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
  | { kind: 'comment'; ts: number; comment: PostedComment }

/** Stable key for `{#each}` — first commit sha of a run, or thread/comment id. */
export function activityEventKey(event: ActivityEvent): string {
  if (event.kind === 'commits') return `commits:${event.commits[0].sha}`
  if (event.kind === 'thread') return event.thread.id
  return event.comment.id
}

/** Who authored a run of commits, deduped ("ashton", "ashton and 2 others"). */
export function commitRunAuthorLabel(commits: PrCommit[], fallback: string): string {
  const authors = [...new Set(commits.map((c) => c.author))].filter(Boolean)
  if (authors.length === 0) return fallback
  if (authors.length === 1) return authors[0]
  return `${authors[0]} and ${authors.length - 1} other${authors.length > 2 ? 's' : ''}`
}

/**
 * Merge pushed commits, review threads, and session comments into one
 * chronologically-sorted timeline so they interleave by when they happened
 * rather than always showing commits-then-threads-then-comments. Adjacent
 * commits (with no thread/comment between them) collapse into a single
 * "added N commits" run; a comment or thread ends the run so two commits
 * followed by a comment render as a two-commit group, then the comment.
 */
export function buildActivityTimeline(
  commits: PrCommit[],
  threads: ReviewThread[],
  posted: PostedComment[],
): ActivityEvent[] {
  type Raw =
    | { kind: 'commit'; ts: number; commit: PrCommit }
    | { kind: 'thread'; ts: number; thread: ReviewThread }
    | { kind: 'comment'; ts: number; comment: PostedComment }
  const raw: Raw[] = []
  for (const commit of commits) {
    raw.push({ kind: 'commit', ts: new Date(commit.committedAt).getTime(), commit })
  }
  for (const thread of threads) {
    const ts = new Date(thread.comments[0]?.createdAt ?? 0).getTime()
    raw.push({ kind: 'thread', ts, thread })
  }
  for (const comment of posted) {
    raw.push({ kind: 'comment', ts: comment.ts, comment })
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
  /** Author login shown until `detail` loads (the list has it from the summary). */
  owner?: string
  /** Repo name for the `repo#number` meta chip; omitted in the list preview. */
  repo?: string
  /** Base branch for the meta line; falls back to `detail.baseRef`. */
  baseRef?: string
  /** Head branch for the meta line; falls back to `detail.headRef`. */
  branch?: string
  /** Diff base for the changed-files rail; falls back to `detail.baseSha`. */
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
