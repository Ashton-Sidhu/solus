import type { FileDiffMetadata, Hunk } from '@pierre/diffs'

export type DiffNoiseKind = 'lockfile' | 'generated' | 'format-only'

export interface DiffNoiseAnalysis {
  kind: DiffNoiseKind | null
  lineCount: number
  formatOnlyLineCount: number
  formatOnlyHunks: number[]
  autoCollapse: boolean
}

const LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
  'package-lock.json',
  'packages.lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
])

const GENERATED_PATH_PATTERNS = [
  /(^|\/)(?:dist|build|coverage|generated|vendor)\//i,
  /(?:^|\.)generated\.[^/]+$/i,
  /(?:\.min\.(?:css|js)|\.map|\.snap)$/i,
  /(?:^|\/)(?:bindings|schema)\.g\.[^/]+$/i,
  /(?:^|\/)generated_[^/]+$/i,
  /\.pb\.(?:go|cc|h|py|rs)$/i,
]

const analysisCache = new WeakMap<FileDiffMetadata, DiffNoiseAnalysis>()
const hunkCache = new WeakMap<Hunk, boolean>()
const formatCollapsedCache = new WeakMap<FileDiffMetadata, FileDiffMetadata>()

function basename(path: string): string {
  return path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
}

export function isLockfilePath(path: string): boolean {
  return LOCKFILE_NAMES.has(basename(path))
}

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

function normalizeFormatLine(line: string): string {
  return line.replace(/\s+/g, '')
}

export function isFormatOnlyHunk(file: FileDiffMetadata, hunk: Hunk): boolean {
  const cached = hunkCache.get(hunk)
  if (cached !== undefined) return cached

  let sawChange = false
  let formatOnly = true
  for (const content of hunk.hunkContent) {
    if (content.type !== 'change') continue
    sawChange = true
    const deletions = file.deletionLines
      .slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions)
      .map(normalizeFormatLine)
    const additions = file.additionLines
      .slice(content.additionLineIndex, content.additionLineIndex + content.additions)
      .map(normalizeFormatLine)
    if (
      deletions.length !== additions.length ||
      deletions.some((line, index) => line !== additions[index])
    ) {
      formatOnly = false
      break
    }
  }

  const result = sawChange && formatOnly
  hunkCache.set(hunk, result)
  return result
}

export function analyzeDiffNoise(file: FileDiffMetadata): DiffNoiseAnalysis {
  const cached = analysisCache.get(file)
  if (cached) return cached

  const formatOnlyHunks: number[] = []
  let lineCount = 0
  let formatOnlyLineCount = 0
  for (let index = 0; index < file.hunks.length; index++) {
    const hunk = file.hunks[index]
    const changedLines = hunk.additionLines + hunk.deletionLines
    lineCount += changedLines
    if (isFormatOnlyHunk(file, hunk)) {
      formatOnlyHunks.push(index)
      formatOnlyLineCount += changedLines
    }
  }

  const kind: DiffNoiseKind | null = isLockfilePath(file.name)
    ? 'lockfile'
    : isGeneratedPath(file.name)
      ? 'generated'
      : file.hunks.length > 0 && formatOnlyHunks.length === file.hunks.length
        ? 'format-only'
        : null
  const result: DiffNoiseAnalysis = {
    kind,
    lineCount,
    formatOnlyLineCount,
    formatOnlyHunks,
    autoCollapse: kind !== null,
  }
  analysisCache.set(file, result)
  return result
}

/** Omits only format-only hunks while retaining original line arrays/anchors. */
export function collapseFormatOnlyHunks(file: FileDiffMetadata): FileDiffMetadata {
  const analysis = analyzeDiffNoise(file)
  if (
    analysis.formatOnlyHunks.length === 0 ||
    analysis.formatOnlyHunks.length === file.hunks.length
  ) return file
  const cached = formatCollapsedCache.get(file)
  if (cached) return cached

  const omitted = new Set(analysis.formatOnlyHunks)
  let splitLineStart = 0
  let unifiedLineStart = 0
  const hunks = file.hunks
    .filter((_, index) => !omitted.has(index))
    .map((hunk) => {
      const adjusted = { ...hunk, splitLineStart, unifiedLineStart }
      splitLineStart += hunk.splitLineCount
      unifiedLineStart += hunk.unifiedLineCount
      return adjusted
    })
  const collapsed: FileDiffMetadata = {
    ...file,
    hunks,
    // Dropping hunks while keeping the line arrays leaves the surviving hunks'
    // `collapsedBefore` gaps describing regions that are no longer there, so this
    // filtered view can't support hunk expansion. Saying so explicitly also keeps
    // the trailing-context arithmetic (which assumes hunks cover the file) off it.
    isPartial: true,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    cacheKey: file.cacheKey ? `${file.cacheKey}:solus-format-collapsed` : undefined,
  }
  formatCollapsedCache.set(file, collapsed)
  return collapsed
}

export function diffNoiseLabel(analysis: DiffNoiseAnalysis): string | null {
  if (!analysis.kind) return null
  const lines = `${analysis.lineCount.toLocaleString()} line${analysis.lineCount === 1 ? '' : 's'}`
  if (analysis.kind === 'format-only') return `${lines} · format-only · collapsed`
  return `${lines} · collapsed`
}
