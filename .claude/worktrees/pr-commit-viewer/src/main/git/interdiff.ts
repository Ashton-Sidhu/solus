import type { ReviewThread } from '../../shared/providers'
import type {
  InterdiffHunk,
  PrInterdiffResult,
  ReviewCheckpoint,
  ReviewThreadHunkMatch,
} from '../../shared/git-types'
import { runAsync } from './exec'
import { readReviewCheckpoint } from '../review/checkpoints'

const MAX_DIFF_BYTES = 50 * 1024 * 1024
const COMMENT_PROXIMITY_LINES = 12

interface ParsedHunk extends InterdiffHunk {
  body: string[]
  raw: string
}

interface ParsedFile {
  filePath: string
  header: string[]
  hunks: ParsedHunk[]
  raw: string
}

export interface PatchSetDelta {
  patch: string
  hunks: InterdiffHunk[]
}

function parseRange(value: string | undefined): number {
  return value === undefined ? 1 : Number(value)
}

function cleanGitPath(value: string): string {
  const trimmed = value.trim()
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
  return unquoted.replace(/^[ab]\//, '')
}

function filePathFor(lines: string[]): string | null {
  const next = lines.find((line) => line.startsWith('+++ '))?.slice(4)
  if (next && next !== '/dev/null') return cleanGitPath(next)
  const previous = lines.find((line) => line.startsWith('--- '))?.slice(4)
  if (previous && previous !== '/dev/null') return cleanGitPath(previous)
  const diff = lines[0]?.match(/^diff --git a\/(.+) b\/(.+)$/)
  return diff?.[2] ?? null
}

function parsePatch(patch: string): ParsedFile[] {
  const chunks = patch.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith('diff --git '))
  const files: ParsedFile[] = []
  for (const chunk of chunks) {
    const lines = chunk.replace(/\n$/, '').split('\n')
    const filePath = filePathFor(lines)
    if (!filePath) continue
    const firstHunk = lines.findIndex((line) => line.startsWith('@@ '))
    const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk)
    const hunks: ParsedHunk[] = []
    let index = firstHunk
    while (index !== -1 && index < lines.length) {
      const headerLine = lines[index]
      const range = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!range) {
        index++
        continue
      }
      let end = index + 1
      while (end < lines.length && !lines[end].startsWith('@@ ')) end++
      const body = lines.slice(index + 1, end)
      const oldStart = Number(range[1])
      const oldLines = parseRange(range[2])
      const newStart = Number(range[3])
      const newLines = parseRange(range[4])
      const raw = [headerLine, ...body].join('\n')
      hunks.push({
        id: `${filePath}:${oldStart}:${newStart}`,
        filePath,
        oldStart,
        oldLines,
        newStart,
        newLines,
        patch: raw,
        body,
        raw,
      })
      index = end
    }
    files.push({ filePath, header, hunks, raw: lines.join('\n') })
  }
  return files
}

function hunkSignature(hunk: ParsedHunk): string {
  // Commit and line-number churn lives outside the body. Comparing only the
  // actual context/add/delete lines makes a patch-identical rebase disappear.
  return hunk.body.filter((line) => line !== '\\ No newline at end of file').join('\n')
}

function hunkDistance(a: ParsedHunk, b: ParsedHunk): number {
  return Math.abs(a.newStart - b.newStart)
}

function reverseHunk(hunk: ParsedHunk): ParsedHunk {
  const body = hunk.body.map((line) => {
    if (line.startsWith('+')) return `-${line.slice(1)}`
    if (line.startsWith('-')) return `+${line.slice(1)}`
    return line
  })
  const raw = `@@ -${hunk.newStart},${hunk.newLines} +${hunk.oldStart},${hunk.oldLines} @@\n${body.join('\n')}`
  return {
    ...hunk,
    id: `${hunk.filePath}:${hunk.newStart}:${hunk.oldStart}:reverted`,
    oldStart: hunk.newStart,
    oldLines: hunk.newLines,
    newStart: hunk.oldStart,
    newLines: hunk.oldLines,
    patch: raw,
    body,
    raw,
  }
}

function minimalHeader(filePath: string): string[] {
  return [`diff --git a/${filePath} b/${filePath}`, `--- a/${filePath}`, `+++ b/${filePath}`]
}

function renderFile(file: ParsedFile | undefined, filePath: string, hunks: ParsedHunk[]): string {
  const header = file?.header.length ? file.header : minimalHeader(filePath)
  return [...header, ...hunks.map((hunk) => hunk.raw)].join('\n')
}

/**
 * Compare two complete PR patches without commit identity. Exact hunks are
 * removed, altered/new hunks use the current patch, and a fully removed prior
 * hunk is reversed so a reviewer can see that the earlier change was reverted.
 */
export function comparePatchSets(previousPatch: string, currentPatch: string): PatchSetDelta {
  const previousFiles = new Map(parsePatch(previousPatch).map((file) => [file.filePath, file]))
  const currentFiles = new Map(parsePatch(currentPatch).map((file) => [file.filePath, file]))
  const orderedPaths = [
    ...currentFiles.keys(),
    ...[...previousFiles.keys()].filter((path) => !currentFiles.has(path)),
  ]
  const rendered: string[] = []
  const deltaHunks: InterdiffHunk[] = []

  for (const filePath of orderedPaths) {
    const previous = previousFiles.get(filePath)
    const current = currentFiles.get(filePath)
    const oldHunks = previous?.hunks ?? []
    const newHunks = current?.hunks ?? []
    const usedOld = new Set<number>()
    const changed: ParsedHunk[] = []

    for (const next of newHunks) {
      const exact = oldHunks.findIndex((old, index) => !usedOld.has(index) && hunkSignature(old) === hunkSignature(next))
      if (exact !== -1) {
        usedOld.add(exact)
        continue
      }
      let nearest = -1
      let distance = Number.POSITIVE_INFINITY
      for (let index = 0; index < oldHunks.length; index++) {
        if (usedOld.has(index)) continue
        const candidateDistance = hunkDistance(oldHunks[index], next)
        if (candidateDistance < distance) {
          nearest = index
          distance = candidateDistance
        }
      }
      // A nearby unmatched hunk is the prior version of this changed hunk. The
      // current hunk alone is the clearest renderable account of the update.
      if (nearest !== -1 && distance <= COMMENT_PROXIMITY_LINES) usedOld.add(nearest)
      changed.push(next)
    }

    for (let index = 0; index < oldHunks.length; index++) {
      if (!usedOld.has(index)) changed.push(reverseHunk(oldHunks[index]))
    }

    // Binary/mode-only patches have no @@ hunks. Preserve the current file patch
    // when its metadata (apart from blob ids) actually changed.
    if (changed.length === 0 && oldHunks.length === 0 && newHunks.length === 0) {
      const normalize = (raw: string | undefined) => (raw ?? '').split('\n').filter((line) => !line.startsWith('index ')).join('\n')
      if (normalize(previous?.raw) !== normalize(current?.raw) && current) rendered.push(current.raw)
      continue
    }
    if (changed.length === 0) continue
    rendered.push(renderFile(current, filePath, changed))
    deltaHunks.push(...changed.map(({ body: _body, raw: _raw, ...hunk }) => hunk))
  }

  return {
    patch: rendered.length ? `${rendered.join('\n')}\n` : '',
    hunks: deltaHunks,
  }
}

export function checkpointState(
  checkpoint: ReviewCheckpoint | null,
  currentHead: string,
  currentBase: string,
): Pick<PrInterdiffResult, 'state' | 'invalidReason'> {
  if (!checkpoint) return { state: 'none' }
  if (checkpoint.base !== currentBase) return { state: 'invalid', invalidReason: 'base-changed' }
  if (checkpoint.headSha === currentHead) return { state: 'unchanged' }
  return { state: 'changed' }
}

function distanceToRange(line: number, start: number, count: number): number {
  const end = start + Math.max(0, count - 1)
  if (line < start) return start - line
  if (line > end) return line - end
  return 0
}

/** Match old inline comments only when a changed hunk in the same file is close enough to be intentional. */
export function anchorReviewThreads(
  threads: ReviewThread[],
  hunks: InterdiffHunk[],
  proximity = COMMENT_PROXIMITY_LINES,
): ReviewThreadHunkMatch[] {
  return threads.map((thread) => {
    if (thread.line == null) return { thread, hunk: null }
    let best: InterdiffHunk | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const hunk of hunks) {
      if (hunk.filePath !== thread.filePath) continue
      const distance = thread.side === 'LEFT'
        ? distanceToRange(thread.line, hunk.oldStart, hunk.oldLines)
        : distanceToRange(thread.line, hunk.newStart, hunk.newLines)
      if (distance < bestDistance) {
        best = hunk
        bestDistance = distance
      }
    }
    return { thread, hunk: bestDistance <= proximity ? best : null }
  })
}

async function gitDiff(cwd: string, from: string, to: string): Promise<string> {
  return runAsync(
    'git',
    ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-color', '--find-renames', from, to],
    cwd,
    { maxBuffer: MAX_DIFF_BYTES },
  )
}

function threadsBeforeCheckpoint(threads: ReviewThread[], reviewedAt: string): ReviewThread[] {
  const cutoff = new Date(reviewedAt).getTime()
  if (!Number.isFinite(cutoff)) return threads
  return threads.filter((thread) => {
    const createdAt = new Date(thread.comments[0]?.createdAt ?? '').getTime()
    return Number.isFinite(createdAt) && createdAt <= cutoff
  })
}

export async function computePrInterdiff(options: {
  repoRoot: string
  gitCwd: string
  prNumber: number
  currentHead: string
  currentBase: string
  threads: ReviewThread[]
}): Promise<PrInterdiffResult> {
  const checkpoint = await readReviewCheckpoint(options.repoRoot, options.prNumber)
  const classification = checkpointState(checkpoint, options.currentHead, options.currentBase)
  const baseResult = {
    checkpoint,
    oldHead: checkpoint?.headSha ?? null,
    currentHead: options.currentHead,
    currentBase: options.currentBase,
    commentMatches: [] as ReviewThreadHunkMatch[],
  }
  if (!checkpoint || classification.state === 'none' || classification.state === 'unchanged') {
    return { ...baseResult, ...classification, patch: '', isFullDiff: false }
  }

  const currentPatch = await gitDiff(options.gitCwd, options.currentBase, options.currentHead)
  if (classification.state === 'invalid') {
    return { ...baseResult, ...classification, patch: currentPatch, isFullDiff: true }
  }

  const oldHeadExists = await runAsync('git', ['cat-file', '-e', `${checkpoint.headSha}^{commit}`], options.gitCwd)
    .then(() => true, () => false)
  if (!oldHeadExists) {
    return {
      ...baseResult,
      state: 'invalid',
      invalidReason: 'old-head-unavailable',
      patch: currentPatch,
      isFullDiff: true,
    }
  }

  const previousPatch = await gitDiff(options.gitCwd, checkpoint.base, checkpoint.headSha)
  const delta = comparePatchSets(previousPatch, currentPatch)
  const priorThreads = threadsBeforeCheckpoint(options.threads, checkpoint.reviewedAt)
  return {
    ...baseResult,
    state: 'changed',
    patch: delta.patch,
    isFullDiff: false,
    commentMatches: anchorReviewThreads(priorThreads, delta.hunks),
  }
}
