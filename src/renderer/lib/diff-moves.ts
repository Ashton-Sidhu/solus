import { parsePatchFiles, type ChangeContent, type FileDiffMetadata, type Hunk } from '@pierre/diffs'

export interface CharacterRange {
  start: number
  length: number
}

export interface MoveLineEdit {
  deletionLine: number | null
  additionLine: number | null
  deletionRanges: CharacterRange[]
  additionRanges: CharacterRange[]
}

export interface MoveBlockRef {
  filePath: string
  hunkIndex: number
  contentIndex: number
  startLine: number
  endLine: number
  lineCount: number
}

export interface DiffMove {
  kind: 'unchanged' | 'modified'
  origin: MoveBlockRef
  destination: MoveBlockRef
  unchangedLineCount: number
  edits: MoveLineEdit[]
}

export interface MovedRenderedLine {
  side: 'old' | 'new'
  lineNumber: number
  editRanges: CharacterRange[]
}

export interface DiffFileMoveSummary {
  unchangedMovedLines: number
  modifiedMovedLines: number
  changedLines: number
  allChangesMovedUnchanged: boolean
  lines: MovedRenderedLine[]
}

export interface DiffMoveAnalysis {
  moves: DiffMove[]
  byFile: Map<string, DiffFileMoveSummary>
}

interface Candidate {
  side: 'old' | 'new'
  file: FileDiffMetadata
  hunk: Hunk
  hunkIndex: number
  contentIndex: number
  content: ChangeContent
  startLine: number
  lines: string[]
}

interface Alignment {
  pairs: Array<[number, number]>
  score: number
}

const MIN_MOVE_LINES = 3
const MIN_MOVE_CHARACTERS = 40
const MODIFIED_MOVE_SIMILARITY = 0.6
const candidateCache = new WeakMap<FileDiffMetadata, Candidate[]>()
const analysisCache = new WeakMap<FileDiffMetadata[], DiffMoveAnalysis>()
const patchMapCache = new WeakMap<Map<string, string>, DiffMoveAnalysis>()

function meaningfulLength(lines: string[]): number {
  return lines.reduce((total, line) => total + line.trim().length, 0)
}

function isMoveSized(lines: string[]): boolean {
  return lines.length >= MIN_MOVE_LINES && meaningfulLength(lines) >= MIN_MOVE_CHARACTERS
}

function candidatesFor(file: FileDiffMetadata): Candidate[] {
  const cached = candidateCache.get(file)
  if (cached) return cached

  const candidates: Candidate[] = []
  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex++) {
    const hunk = file.hunks[hunkIndex]
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (let contentIndex = 0; contentIndex < hunk.hunkContent.length; contentIndex++) {
      const content = hunk.hunkContent[contentIndex]
      if (content.type === 'context') {
        oldLine += content.lines
        newLine += content.lines
        continue
      }
      const deleted = file.deletionLines.slice(
        content.deletionLineIndex,
        content.deletionLineIndex + content.deletions,
      )
      const added = file.additionLines.slice(
        content.additionLineIndex,
        content.additionLineIndex + content.additions,
      )
      if (isMoveSized(deleted)) {
        candidates.push({
          side: 'old', file, hunk, hunkIndex, contentIndex, content,
          startLine: oldLine, lines: deleted,
        })
      }
      if (isMoveSized(added)) {
        candidates.push({
          side: 'new', file, hunk, hunkIndex, contentIndex, content,
          startLine: newLine, lines: added,
        })
      }
      oldLine += content.deletions
      newLine += content.additions
    }
  }
  candidateCache.set(file, candidates)
  return candidates
}

function normalizedLine(line: string): string {
  return line.trimEnd()
}

function exactKey(lines: string[]): string {
  return lines.map(normalizedLine).join('\u0000')
}

function sameChange(origin: Candidate, destination: Candidate): boolean {
  return origin.file === destination.file &&
    origin.hunk === destination.hunk &&
    origin.content === destination.content
}

function lcsAlignment(oldLines: string[], newLines: string[]): Alignment {
  const oldNormalized = oldLines.map(normalizedLine)
  const newNormalized = newLines.map(normalizedLine)
  const width = newLines.length + 1
  const table = new Uint16Array((oldLines.length + 1) * width)
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const index = oldIndex * width + newIndex
      table[index] = oldNormalized[oldIndex] === newNormalized[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[index + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldNormalized[oldIndex] === newNormalized[newIndex]) {
      pairs.push([oldIndex++, newIndex++])
    } else if (table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
      oldIndex++
    } else {
      newIndex++
    }
  }
  return { pairs, score: pairs.length / Math.max(oldLines.length, newLines.length) }
}

function characterRanges(before: string, after: string): [CharacterRange[], CharacterRange[]] {
  let prefix = 0
  const maxPrefix = Math.min(before.length, after.length)
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++

  let suffix = 0
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix)
  while (
    suffix < maxSuffix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix++

  const beforeLength = before.length - prefix - suffix
  const afterLength = after.length - prefix - suffix
  return [
    beforeLength > 0 ? [{ start: prefix, length: beforeLength }] : [],
    afterLength > 0 ? [{ start: prefix, length: afterLength }] : [],
  ]
}

function buildEdits(origin: Candidate, destination: Candidate, alignment: Alignment): MoveLineEdit[] {
  const edits: MoveLineEdit[] = []
  const anchors: Array<[number, number]> = [[-1, -1], ...alignment.pairs, [origin.lines.length, destination.lines.length]]
  for (let index = 1; index < anchors.length; index++) {
    const [previousOld, previousNew] = anchors[index - 1]
    const [nextOld, nextNew] = anchors[index]
    const oldGap = nextOld - previousOld - 1
    const newGap = nextNew - previousNew - 1
    const count = Math.max(oldGap, newGap)
    for (let offset = 0; offset < count; offset++) {
      const oldIndex = offset < oldGap ? previousOld + offset + 1 : null
      const newIndex = offset < newGap ? previousNew + offset + 1 : null
      const oldText = oldIndex === null ? '' : origin.lines[oldIndex]
      const newText = newIndex === null ? '' : destination.lines[newIndex]
      const [deletionRanges, additionRanges] = characterRanges(oldText, newText)
      edits.push({
        deletionLine: oldIndex === null ? null : origin.startLine + oldIndex,
        additionLine: newIndex === null ? null : destination.startLine + newIndex,
        deletionRanges,
        additionRanges,
      })
    }
  }
  return edits
}

function toRef(candidate: Candidate): MoveBlockRef {
  return {
    filePath: candidate.file.name,
    hunkIndex: candidate.hunkIndex,
    contentIndex: candidate.contentIndex,
    startLine: candidate.startLine,
    endLine: candidate.startLine + candidate.lines.length - 1,
    lineCount: candidate.lines.length,
  }
}

function changedLineCount(file: FileDiffMetadata): number {
  return file.hunks.reduce((total, hunk) => total + hunk.additionLines + hunk.deletionLines, 0)
}

function buildFileSummaries(files: FileDiffMetadata[], moves: DiffMove[]): Map<string, DiffFileMoveSummary> {
  const byFile = new Map<string, DiffFileMoveSummary>()
  for (const file of files) {
    byFile.set(file.name, {
      unchangedMovedLines: 0,
      modifiedMovedLines: 0,
      changedLines: changedLineCount(file),
      allChangesMovedUnchanged: false,
      lines: [],
    })
  }
  for (const move of moves) {
    const origin = byFile.get(move.origin.filePath)
    const destination = byFile.get(move.destination.filePath)
    if (!origin || !destination) continue
    const modified = move.kind === 'modified'
    if (modified) {
      origin.modifiedMovedLines += move.origin.lineCount
      destination.modifiedMovedLines += move.destination.lineCount
    } else {
      origin.unchangedMovedLines += move.origin.lineCount
      destination.unchangedMovedLines += move.destination.lineCount
    }
    const oldEdits = new Map(move.edits.filter((edit) => edit.deletionLine !== null).map((edit) => [edit.deletionLine, edit.deletionRanges]))
    const newEdits = new Map(move.edits.filter((edit) => edit.additionLine !== null).map((edit) => [edit.additionLine, edit.additionRanges]))
    for (let line = move.origin.startLine; line <= move.origin.endLine; line++) {
      origin.lines.push({ side: 'old', lineNumber: line, editRanges: oldEdits.get(line) ?? [] })
    }
    for (let line = move.destination.startLine; line <= move.destination.endLine; line++) {
      destination.lines.push({ side: 'new', lineNumber: line, editRanges: newEdits.get(line) ?? [] })
    }
  }
  for (const summary of byFile.values()) {
    summary.allChangesMovedUnchanged = summary.changedLines > 0 &&
      summary.unchangedMovedLines === summary.changedLines &&
      summary.modifiedMovedLines === 0
  }
  return byFile
}

export function detectMovedBlocks(files: FileDiffMetadata[]): DiffMoveAnalysis {
  const cached = analysisCache.get(files)
  if (cached) return cached

  const candidates = files.flatMap(candidatesFor)
  const deletions = candidates.filter((candidate) => candidate.side === 'old')
  const additions = candidates.filter((candidate) => candidate.side === 'new')
  const possible: Array<{ origin: Candidate; destination: Candidate; alignment: Alignment; exact: boolean }> = []
  const additionsByKey = new Map<string, Candidate[]>()
  for (const addition of additions) {
    const key = exactKey(addition.lines)
    const values = additionsByKey.get(key)
    if (values) values.push(addition)
    else additionsByKey.set(key, [addition])
  }

  const exactOrigins = new Set<Candidate>()
  const exactDestinations = new Set<Candidate>()
  for (const origin of deletions) {
    for (const destination of additionsByKey.get(exactKey(origin.lines)) ?? []) {
      if (sameChange(origin, destination)) continue
      const pairs = origin.lines.map((_, index) => [index, index] as [number, number])
      possible.push({ origin, destination, alignment: { pairs, score: 1 }, exact: true })
      exactOrigins.add(origin)
      exactDestinations.add(destination)
    }
  }

  // Only run the bounded LCS comparison for blocks that share a meaningful
  // line. This avoids an O(deletions × additions) scan on large generated
  // diffs while still finding a moved function whose few edited lines changed.
  const additionsByAnchor = new Map<string, Candidate[]>()
  for (const destination of additions) {
    if (exactDestinations.has(destination)) continue
    const anchors = new Set(destination.lines.map(normalizedLine).filter((line) => line.trim().length >= 8))
    for (const anchor of anchors) {
      const values = additionsByAnchor.get(anchor)
      if (values) values.push(destination)
      else additionsByAnchor.set(anchor, [destination])
    }
  }
  for (const origin of deletions) {
    if (exactOrigins.has(origin)) continue
    const overlap = new Map<Candidate, number>()
    const anchors = new Set(origin.lines.map(normalizedLine).filter((line) => line.trim().length >= 8))
    for (const anchor of anchors) {
      for (const destination of additionsByAnchor.get(anchor) ?? []) {
        overlap.set(destination, (overlap.get(destination) ?? 0) + 1)
      }
    }
    const nearby = [...overlap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([destination]) => destination)
    for (const destination of nearby) {
      if (exactDestinations.has(destination) || sameChange(origin, destination)) continue
      const lengthRatio = origin.lines.length / destination.lines.length
      if (lengthRatio < 0.5 || lengthRatio > 2) continue
      if (origin.lines.length * destination.lines.length > 250_000) continue
      const alignment = lcsAlignment(origin.lines, destination.lines)
      if (alignment.score >= MODIFIED_MOVE_SIMILARITY) {
        possible.push({ origin, destination, alignment, exact: false })
      }
    }
  }

  possible.sort((a, b) =>
    Number(b.exact) - Number(a.exact) ||
    b.alignment.score - a.alignment.score ||
    Math.max(b.origin.lines.length, b.destination.lines.length) -
      Math.max(a.origin.lines.length, a.destination.lines.length),
  )

  const usedOrigins = new Set<Candidate>()
  const usedDestinations = new Set<Candidate>()
  const moves: DiffMove[] = []
  for (const match of possible) {
    if (usedOrigins.has(match.origin) || usedDestinations.has(match.destination)) continue
    usedOrigins.add(match.origin)
    usedDestinations.add(match.destination)
    moves.push({
      kind: match.exact ? 'unchanged' : 'modified',
      origin: toRef(match.origin),
      destination: toRef(match.destination),
      unchangedLineCount: match.alignment.pairs.length,
      edits: match.exact ? [] : buildEdits(match.origin, match.destination, match.alignment),
    })
  }

  const result = { moves, byFile: buildFileSummaries(files, moves) }
  analysisCache.set(files, result)
  return result
}

/** Cross-file guide adapter, cached on the stable split-patch map. */
export function detectMovedBlocksInPatches(patches: Map<string, string>): DiffMoveAnalysis {
  const cached = patchMapCache.get(patches)
  if (cached) return cached
  const files = [...patches.values()].flatMap((patch) =>
    parsePatchFiles(patch).flatMap((parsed) => parsed.files),
  )
  const analysis = detectMovedBlocks(files)
  patchMapCache.set(patches, analysis)
  return analysis
}
