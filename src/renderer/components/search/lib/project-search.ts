import type { ProjectContentMatch, ProjectContentMatchRange } from '../../../../shared/types'

/** A match paired with its position in the flat result list, which is what
 *  ↑/↓ navigate — selection has to cross file boundaries, so the index cannot
 *  live inside a group. */
export interface IndexedMatch extends ProjectContentMatch {
  index: number
}

export interface MatchGroup {
  path: string
  /** File name only — the bold half of the group header. */
  name: string
  /** Everything before the file name, without the trailing slash. */
  directory: string
  matches: IndexedMatch[]
}

/** One run of the matched line, flagged for `<mark>` rendering and carrying the
 *  syntax colour of the token it came from. */
export interface LineSegment {
  text: string
  isMatch: boolean
  color?: string
  fontStyle?: number
}

/** The line as it is rendered — indentation stripped, ranges moved with it. */
export interface VisibleLine {
  text: string
  ranges: ProjectContentMatchRange[]
}

export function splitPath(path: string): { name: string; directory: string } {
  const separator = path.lastIndexOf('/')
  return separator === -1
    ? { name: path, directory: '' }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator) }
}

/** Group consecutive matches by file, preserving the engine's frecency order. */
export function groupMatches(matches: readonly ProjectContentMatch[], offset = 0): MatchGroup[] {
  const groups: MatchGroup[] = []
  matches.forEach((match, position) => {
    let group = groups.at(-1)
    if (!group || group.path !== match.path) {
      group = { path: match.path, ...splitPath(match.path), matches: [] }
      groups.push(group)
    }
    group.matches.push({ ...match, index: offset + position })
  })
  return groups
}

/**
 * Clamp, sort and merge the engine's ranges before slicing. Overlapping ranges
 * would otherwise emit the same characters twice, and an out-of-bounds end
 * would silently drop the tail of the line.
 */
function normalizeRanges(line: string, ranges: readonly ProjectContentMatchRange[]): ProjectContentMatchRange[] {
  const clamped = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(line.length, range.start)),
      end: Math.max(0, Math.min(line.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start)

  const merged: ProjectContentMatchRange[] = []
  for (const range of clamped) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/**
 * The rendered form of a matched line. Leading whitespace is stripped so deeply
 * indented hits still show their code rather than a row of blank space, and the
 * match ranges move with it. Exported because the syntax highlighter must
 * tokenize exactly this string for token offsets to line up with the ranges.
 */
export function visibleLine(match: ProjectContentMatch, maxLength = 400): VisibleLine {
  const indent = match.lineContent.length - match.lineContent.trimStart().length
  const text = match.lineContent.slice(indent, indent + maxLength)
  return {
    text,
    ranges: normalizeRanges(
      text,
      match.matchRanges.map((range) => ({ start: range.start - indent, end: range.end - indent })),
    ),
  }
}

/**
 * Split a line into alternating plain and matched runs, subdividing each
 * syntax token at the match edges so a highlight can start mid-token without
 * losing that token's colour. Without `tokens` the whole line is one uncoloured
 * token, which is the plain-text fallback.
 */
export function lineSegments(
  line: VisibleLine,
  tokens?: readonly LineSegmentToken[] | null,
): LineSegment[] {
  const source: readonly LineSegmentToken[] =
    tokens && tokens.length > 0 ? tokens : [{ content: line.text, offset: 0 }]

  const segments: LineSegment[] = []
  for (const token of source) {
    const tokenEnd = token.offset + token.content.length
    let cursor = token.offset
    for (const range of line.ranges) {
      if (range.end <= cursor) continue
      if (range.start >= tokenEnd) break
      const matchStart = Math.max(cursor, range.start)
      if (matchStart > cursor) segments.push(styled(line.text, cursor, matchStart, false, token))
      const matchEnd = Math.min(tokenEnd, range.end)
      segments.push(styled(line.text, matchStart, matchEnd, true, token))
      cursor = matchEnd
    }
    if (cursor < tokenEnd) segments.push(styled(line.text, cursor, tokenEnd, false, token))
  }
  return segments
}

/** The token shape `lineSegments` needs — a subset of the highlighter's. */
export interface LineSegmentToken {
  content: string
  offset: number
  color?: string
  fontStyle?: number
}

function styled(
  line: string,
  start: number,
  end: number,
  isMatch: boolean,
  token: LineSegmentToken,
): LineSegment {
  const segment: LineSegment = { text: line.slice(start, end), isMatch }
  if (token.color) segment.color = token.color
  if (token.fontStyle) segment.fontStyle = token.fontStyle
  return segment
}

/** Inline style for a segment, or `undefined` when it needs none. */
export function segmentStyle(segment: LineSegment): string | undefined {
  const style = segment.fontStyle ?? 0
  const parts = [
    segment.color ? `color:${segment.color}` : '',
    style & 1 ? 'font-style:italic' : '',
    style & 2 ? 'font-weight: 500' : '',
    style & 4 ? 'text-decoration:underline' : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(';') : undefined
}

export function distinctFileCount(matches: readonly ProjectContentMatch[]): number {
  return new Set(matches.map((match) => match.path)).size
}
