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
import type { FileDiffMetadata, Hunk } from '@pierre/diffs'
import { quoteGitPath } from '@solus/client-core/git-path-name'
import { groupThreadsByReview, reviewIsEvent } from '@solus/client-core/review-groups'
import { labelChangeText } from '../../../lib/label-activity'
import { parsePatchMetadata, patchFileChunks } from '../../../lib/pierre-diff'
import type { PrArtifact } from './pr-artifacts'

/**
 * Whether a thread's timeline row starts folded to one line. A resolved thread
 * is settled, and an outdated one is anchored to code the branch has since
 * changed; GitHub folds both. An open thread on current code asks the reader
 * to act, so it shows in full.
 */
export function threadStartsFolded(thread: Pick<ReviewThread, 'isResolved' | 'isOutdated'>): boolean {
  return thread.isResolved || thread.isOutdated
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
  /** A thread submitted outside a review, or whose review is not in the conversation. */
  | { kind: 'thread'; ts: number; thread: ReviewThread }
  /** A comment, or a review with the threads it was submitted with nested
   *  under it (empty for a comment). */
  | { kind: 'comment'; ts: number; comment: PrCommentActivityItem; threads: ReviewThread[] }
  | { kind: 'label'; ts: number; item: PrLabelActivityItem }
  /** A render linked to a task on this pull request, at the moment it was
   *  linked. Local to Solus: the host never sees it. */
  | { kind: 'artifact'; ts: number; artifact: PrArtifact }

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
  if (event.kind === 'artifact') return `artifact:${event.artifact.workId}`
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
  if (unresolvedOnly) {
    // Nested threads surface on their own here: the filter asks for the
    // threads, not the reviews they came with.
    return events.flatMap((e): ActivityEvent[] => {
      if (e.kind === 'thread') return e.thread.isResolved ? [] : [e]
      if (e.kind !== 'comment') return []
      return e.threads
        .filter((thread) => !thread.isResolved)
        .map((thread) => ({ kind: 'thread', ts: threadTime(thread), thread }))
    })
  }
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
 *
 * A review's inline threads nest under it, as the host shows them, and sit at
 * the review's time; a thread without a review in the conversation stands
 * alone at its own. A comment-only review with nothing to say and no thread
 * is not an event (`reviewIsEvent`).
 */
function threadTime(thread: ReviewThread): number {
  return new Date(thread.comments[0]?.createdAt ?? 0).getTime()
}

export function buildActivityTimeline(
  commits: PrCommit[],
  threads: ReviewThread[],
  comments: PrConversationItem[],
  artifacts: PrArtifact[] = [],
): ActivityEvent[] {
  type Raw =
    | { kind: 'commit'; ts: number; commit: PrCommit }
    | { kind: 'thread'; ts: number; thread: ReviewThread }
    | { kind: 'comment'; ts: number; comment: PrCommentActivityItem; threads: ReviewThread[] }
    | { kind: 'label'; ts: number; item: PrLabelActivityItem }
    | { kind: 'artifact'; ts: number; artifact: PrArtifact }
  const raw: Raw[] = []
  const groups = groupThreadsByReview(comments, threads)
  for (const artifact of artifacts) {
    raw.push({ kind: 'artifact', ts: artifact.linkedAt, artifact })
  }
  for (const commit of commits) {
    raw.push({ kind: 'commit', ts: new Date(commit.committedAt).getTime(), commit })
  }
  for (const thread of groups.standalone) {
    raw.push({ kind: 'thread', ts: threadTime(thread), thread })
  }
  for (const comment of comments) {
    const ts = new Date(comment.createdAt).getTime()
    if (comment.kind === 'label') {
      raw.push({ kind: 'label', ts, item: comment })
      continue
    }
    const nested = (groups.byReview.get(comment.id) ?? []).sort((a, b) => threadTime(a) - threadTime(b))
    if (!reviewIsEvent(comment, nested)) continue
    raw.push({ kind: 'comment', ts, comment, threads: nested })
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
    } else if (item.kind === 'artifact') {
      events.push({ kind: 'artifact', ts: item.ts, artifact: item.artifact })
    } else {
      events.push({ kind: 'comment', ts: item.ts, comment: item.comment, threads: item.threads })
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
  const oldPath = quoteGitPath(`a/${filePath}`)
  const newPath = quoteGitPath(`b/${filePath}`)
  return `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n${hunk}\n`
}

/** Rendered rows in a bare hunk: every line after the `@@` header. */
export function diffLineCount(hunk: string): number {
  const lines = hunk.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return Math.max(0, lines.length - 1)
}

/** GitHub-sized context on each side of the reviewed line. */
export const ACTIVITY_DIFF_CONTEXT_LINES = 3

export interface ActivityDiffPreview {
  hunk: string
  hiddenBeforeLineCount: number
  hiddenAfterLineCount: number
}

/** One row of a parsed hunk, as Pierre renders it. `text` keeps the line end
 *  the parser read; a line with no line end is the last line of its file. */
interface HunkRow {
  prefix: ' ' | '-' | '+'
  text: string
  oldLine: number | null
  newLine: number | null
}

/** The rows of a parsed hunk in the order Pierre renders them: each context
 *  run, and each change with its deletions before its additions. */
function hunkRows(file: FileDiffMetadata, hunk: Hunk): HunkRow[] {
  const rows: HunkRow[] = []
  const oldLine = (index: number) => hunk.deletionStart + index - hunk.deletionLineIndex
  const newLine = (index: number) => hunk.additionStart + index - hunk.additionLineIndex
  for (const content of hunk.hunkContent) {
    if (content.type === 'context') {
      for (let offset = 0; offset < content.lines; offset++) {
        const deletionIndex = content.deletionLineIndex + offset
        const additionIndex = content.additionLineIndex + offset
        rows.push({ prefix: ' ', text: file.additionLines[additionIndex] ?? '', oldLine: oldLine(deletionIndex), newLine: newLine(additionIndex) })
      }
      continue
    }
    for (let offset = 0; offset < content.deletions; offset++) {
      const index = content.deletionLineIndex + offset
      rows.push({ prefix: '-', text: file.deletionLines[index] ?? '', oldLine: oldLine(index), newLine: null })
    }
    for (let offset = 0; offset < content.additions; offset++) {
      const index = content.additionLineIndex + offset
      rows.push({ prefix: '+', text: file.additionLines[index] ?? '', oldLine: null, newLine: newLine(index) })
    }
  }
  return rows
}

/** A row as unified diff text, with the marker git writes after a last line
 *  that has no line end. */
function rowLines(row: HunkRow): string[] {
  if (row.text.endsWith('\n')) return [row.prefix + row.text.slice(0, -1)]
  return [row.prefix + row.text, '\\ No newline at end of file']
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
  const file = parsePatchMetadata(hunkToPatch('preview', hunk))
  const parsedHunk = file?.hunks[0]
  const rows = file && parsedHunk ? hunkRows(file, parsedHunk) : []
  if (!parsedHunk || rows.length === 0) {
    return { hunk, hiddenBeforeLineCount: 0, hiddenAfterLineCount: 0 }
  }

  const anchorRow = anchorLine === null
    ? -1
    : rows.findIndex((row) => (side === 'LEFT' ? row.oldLine : row.newLine) === anchorLine)
  const anchorIndex = anchorRow === -1 ? rows.length - 1 : anchorRow
  const previewStart = Math.max(0, anchorIndex - ACTIVITY_DIFF_CONTEXT_LINES)
  const previewEnd = Math.min(rows.length, anchorIndex + ACTIVITY_DIFF_CONTEXT_LINES + 1)
  const start = showBefore ? 0 : previewStart
  const end = showAfter ? rows.length : previewEnd
  const hiddenBeforeLineCount = previewStart
  const hiddenAfterLineCount = rows.length - previewEnd
  if (start === 0 && end === rows.length) {
    return { hunk, hiddenBeforeLineCount, hiddenAfterLineCount }
  }

  const omittedRows = rows.slice(0, start)
  const visibleRows = rows.slice(start, end)
  const oldStart = parsedHunk.deletionStart + omittedRows.filter((row) => row.oldLine !== null).length
  const newStart = parsedHunk.additionStart + omittedRows.filter((row) => row.newLine !== null).length
  const oldCount = visibleRows.filter((row) => row.oldLine !== null).length
  const newCount = visibleRows.filter((row) => row.newLine !== null).length
  const context = parsedHunk.hunkContext ? ` ${parsedHunk.hunkContext}` : ''
  const previewHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${context}`

  return {
    hunk: [previewHeader, ...visibleRows.flatMap(rowLines)].join('\n'),
    hiddenBeforeLineCount,
    hiddenAfterLineCount,
  }
}

/** The hunk of a parsed file that holds `line` on `side`, as unified diff text. */
function hunkAtLine(file: FileDiffMetadata, line: number, side: 'LEFT' | 'RIGHT'): string | null {
  const hunk = file.hunks.find((candidate) => {
    const start = side === 'LEFT' ? candidate.deletionStart : candidate.additionStart
    const count = side === 'LEFT' ? candidate.deletionCount : candidate.additionCount
    return line >= start && line < start + count
  })
  if (!hunk) return null
  const header = hunk.hunkSpecs?.replace(/\r?\n$/, '')
    ?? `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`
  return [header, ...hunkRows(file, hunk).flatMap(rowLines)].join('\n')
}

/** Find each review thread's complete containing hunk. This supplies context
 * after GitHub's shorter comment hunk. A mounted feed must not parse and keep
 * the whole PR patch: only the file headers are parsed, then only the files
 * that have a thread. Those parses are cached by file text in
 * `parsePatchMetadata`, so a feed that renders again does not parse again. */
export function reviewThreadDiffHunks(
  patch: string | null,
  events: readonly ActivityEvent[],
): Map<string, string> {
  const hunks = new Map<string, string>()
  if (!patch) return hunks
  const threadsByPath = new Map<string, ReviewThread[]>()
  const addThread = (thread: ReviewThread) => {
    if (thread.line === null) return
    const threads = threadsByPath.get(thread.filePath)
    if (threads) threads.push(thread)
    else threadsByPath.set(thread.filePath, [thread])
  }
  for (const event of events) {
    if (event.kind === 'thread') addThread(event.thread)
    else if (event.kind === 'comment') event.threads.forEach(addThread)
  }
  if (threadsByPath.size === 0) return hunks

  for (const chunk of patchFileChunks(patch)) {
    const threads = [
      ...(threadsByPath.get(chunk.path) ?? []),
      ...(chunk.previousPath ? threadsByPath.get(chunk.previousPath) ?? [] : []),
    ]
    if (threads.length === 0) continue
    const file = parsePatchMetadata(chunk.text)
    if (!file) continue
    for (const thread of threads) {
      if (thread.line === null) continue
      const hunk = hunkAtLine(file, thread.line, thread.side)
      if (hunk) hunks.set(thread.id, hunk)
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
