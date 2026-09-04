// Private logic for the Activity overview: shaping GitHub diff hunks for the
// inline thread previews, and the initials shown in author/comment avatars.
// (Per-file +/- counts come from the provider-backed `prChangedFiles` handler.)

import type {
  PrCommit,
  PrCommentActivityItem,
  PrConversationItem,
  PrLabelActivityItem,
  ReviewThread,
} from '@solus/contracts/providers'
import { labelChangeText } from '../../../lib/label-activity'

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
  | { kind: 'comment'; ts: number; comment: PrCommentActivityItem }
  | { kind: 'label'; ts: number; item: PrLabelActivityItem }

/** The provider reads the Activity tab makes on its own. Each fails on its
 *  own too, and the section that read it says so in place — there is no
 *  page-wide banner to fold them into. */
export type PrActivityDataSource =
  | 'details'
  | 'commits'
  | 'comments'
  | 'reviewers'
  | 'reviewer-candidates'
  | 'label-candidates'
  | 'changed-files'

/** Stable key for `{#each}` — first commit sha of a run, or thread/comment id. */
export function activityEventKey(event: ActivityEvent): string {
  if (event.kind === 'commits') return `commits:${event.commits[0].sha}`
  if (event.kind === 'thread') return event.thread.id
  if (event.kind === 'label') return event.item.id
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
  if (filter === 'conversation') {
    return events.filter((event) => event.kind === 'thread' || event.kind === 'comment')
  }
  if (filter === 'commits') return events.filter((e) => e.kind === 'commits')
  return events
}

/**
 * Whether a conversation body paints anything once rendered. Bots wrap their
 * state in HTML comments, and a review whose only content is such a marker
 * arrives with a non-empty body that the markdown pipeline hides in full — a
 * row that keeps its card for it shows an empty box under the author line.
 */
export function hasVisibleBody(body: string): boolean {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim().length > 0
}

/** Count body-bearing conversation entries without treating label events as feedback. */
export function visibleConversationCount(items: PrConversationItem[]): number {
  return items.reduce(
    (count, item) => count + (item.kind !== 'label' && hasVisibleBody(item.body) ? 1 : 0),
    0,
  )
}

/**
 * A review verdict worth promoting to a timeline milestone. Non-null only for
 * approvals and change requests — COMMENTED/DISMISSED reviews stay ordinary
 * avatar rows since their state carries no verdict.
 */
export function reviewMilestone(
  item: PrCommentActivityItem,
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
export interface CommitRunPreview { visible: PrCommit[]; hidden: number }

export function commitRunPreview(
  commits: PrCommit[],
  expanded: boolean,
): CommitRunPreview {
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
    | { kind: 'comment'; ts: number; comment: PrCommentActivityItem }
    | { kind: 'label'; ts: number; item: PrLabelActivityItem }
  const raw: Raw[] = []
  for (const commit of commits) {
    raw.push({ kind: 'commit', ts: new Date(commit.committedAt).getTime(), commit })
  }
  for (const thread of threads) {
    const ts = new Date(thread.comments[0]?.createdAt ?? 0).getTime()
    raw.push({ kind: 'thread', ts, thread })
  }
  for (const comment of comments) {
    const ts = new Date(comment.createdAt).getTime()
    if (comment.kind === 'label') raw.push({ kind: 'label', ts, item: comment })
    else raw.push({ kind: 'comment', ts, comment })
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
    } else if (item.kind === 'label') {
      events.push({ kind: 'label', ts: item.ts, item: item.item })
    } else {
      events.push({ kind: 'comment', ts: item.ts, comment: item.comment })
    }
  }
  return events
}

export function prLabelActivityText(item: PrLabelActivityItem, viewerLogin: string): string {
  const who = item.author === viewerLogin ? 'You' : item.author || 'Someone'
  return labelChangeText(
    who,
    item.action === 'added' ? [item.label.name] : [],
    item.action === 'removed' ? [item.label.name] : [],
  )
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

/** GitHub-sized context on each side of the reviewed line. */
export const ACTIVITY_DIFF_CONTEXT_LINES = 3

export interface ActivityDiffPreview {
  hunk: string
  hiddenBeforeLineCount: number
  hiddenAfterLineCount: number
}

function consumesOldLine(line: string): boolean {
  return !line.startsWith('+') && !line.startsWith('\\')
}

function consumesNewLine(line: string): boolean {
  return !line.startsWith('-') && !line.startsWith('\\')
}

function lineNumberAt(
  contentLines: readonly string[],
  start: number,
  side: 'LEFT' | 'RIGHT',
  target: number,
): number {
  let lineNumber = start
  for (let index = 0; index < contentLines.length; index++) {
    const consumesLine = side === 'LEFT'
      ? consumesOldLine(contentLines[index])
      : consumesNewLine(contentLines[index])
    if (consumesLine) {
      if (lineNumber === target) return index
      lineNumber++
    }
  }
  return contentLines.length - 1
}

/** Center a valid unified hunk on its review anchor. Each omitted side can be
 * revealed independently without changing the line numbers Pierre renders. */
export function activityDiffPreview(
  hunk: string,
  anchorLine: number | null,
  side: 'LEFT' | 'RIGHT',
  showBefore = false,
  showAfter = false,
): ActivityDiffPreview {
  const lines = hunk.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const header = lines[0] ?? ''
  const headerMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header)
  const contentLines = lines.slice(1)
  if (!headerMatch || contentLines.length === 0) {
    return { hunk, hiddenBeforeLineCount: 0, hiddenAfterLineCount: 0 }
  }

  const anchorIndex = anchorLine === null
    ? contentLines.length - 1
    : lineNumberAt(
        contentLines,
        Number(headerMatch[side === 'LEFT' ? 1 : 2]),
        side,
        anchorLine,
      )
  const previewStart = Math.max(0, anchorIndex - ACTIVITY_DIFF_CONTEXT_LINES)
  const previewEnd = Math.min(contentLines.length, anchorIndex + ACTIVITY_DIFF_CONTEXT_LINES + 1)
  const start = showBefore ? 0 : previewStart
  const end = showAfter ? contentLines.length : previewEnd
  const hiddenBeforeLineCount = previewStart
  const hiddenAfterLineCount = contentLines.length - previewEnd
  if (start === 0 && end === contentLines.length) {
    return { hunk, hiddenBeforeLineCount, hiddenAfterLineCount }
  }

  const omittedLines = contentLines.slice(0, start)
  const visibleLines = contentLines.slice(start, end)
  const oldStart = Number(headerMatch[1]) + omittedLines.filter(consumesOldLine).length
  const newStart = Number(headerMatch[2]) + omittedLines.filter(consumesNewLine).length
  const oldCount = visibleLines.filter(consumesOldLine).length
  const newCount = visibleLines.filter(consumesNewLine).length
  const previewHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${headerMatch[3] ?? ''}`

  return {
    hunk: [previewHeader, ...visibleLines].join('\n'),
    hiddenBeforeLineCount,
    hiddenAfterLineCount,
  }
}

function headerPath(line: string): string | null {
  const encoded = line.slice(4)
  if (encoded === '/dev/null') return null
  let path = encoded
  if (encoded.startsWith('"')) {
    try {
      // SAFETY: This branch accepts a JSON-style quoted git path; malformed
      // values throw into the fallback below instead of entering the path map.
      path = JSON.parse(encoded) as string
    } catch {
      return null
    }
  }
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

function hunkAtLine(chunk: string, line: number, side: 'LEFT' | 'RIGHT'): string | null {
  const lines = chunk.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index])
    if (!match) continue
    const start = Number(match[side === 'LEFT' ? 1 : 3])
    const count = Number(match[side === 'LEFT' ? 2 : 4] ?? 1)
    if (line < start || line >= start + count) continue
    let end = index + 1
    while (end < lines.length && !lines[end].startsWith('@@ ')) end++
    while (lines[end - 1] === '') end--
    return lines.slice(index, end).join('\n')
  }
  return null
}

/** Find each review thread's complete containing hunk in one cheap pass over
 * the PR patch. This supplies context after GitHub's shorter comment hunk
 * without parsing and retaining the entire diff for every mounted feed. */
export function reviewThreadDiffHunks(
  patch: string | null,
  events: readonly ActivityEvent[],
): Map<string, string> {
  const hunks = new Map<string, string>()
  if (!patch) return hunks
  const threadsByPath = new Map<string, ReviewThread[]>()
  for (const event of events) {
    if (event.kind !== 'thread' || event.thread.line === null) continue
    const threads = threadsByPath.get(event.thread.filePath)
    if (threads) threads.push(event.thread)
    else threadsByPath.set(event.thread.filePath, [event.thread])
  }

  for (const chunk of patch.split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue
    const paths = chunk
      .split('\n')
      .filter((line) => line.startsWith('--- ') || line.startsWith('+++ '))
      .map(headerPath)
      .filter((path): path is string => path !== null)
    for (const path of paths) {
      for (const thread of threadsByPath.get(path) ?? []) {
        if (thread.line === null) continue
        const hunk = hunkAtLine(chunk, thread.line, thread.side)
        if (hunk) hunks.set(thread.id, hunk)
      }
    }
  }
  return hunks
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
