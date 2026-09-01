import type { GrepCursor } from '@ff-labs/fff-node'
import type {
  ProjectContentMatch,
  ProjectContentMatchRange,
  ProjectContentSearchRequest,
  ProjectContentSearchResult,
} from '@solus/contracts/types'
import { getContentFinder } from '@solus/server/server/file-finder'
import { createLogger } from '@solus/server/logger'

const log = createLogger('main', 'content-search')

/** Matches returned to the renderer. Enough to scroll, few enough to render. */
export const CONTENT_SEARCH_MAX_MATCHES = 500
/** A search runs while the user is still typing, so it must return promptly
 *  with whatever it found rather than finish the tree. */
const TIME_BUDGET_MS = 250
/** One dense file must not consume the whole page of results. */
const MAX_MATCHES_PER_FILE = 100

interface ContentQuery {
  query: string
  regexMode: boolean
}

const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u

function isWord(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character)
}

function codePointAt(line: string, index: number): string | undefined {
  const codePoint = line.codePointAt(index)
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint)
}

function codePointBefore(line: string, index: number): string | undefined {
  if (index <= 0) return undefined
  const previousUnit = line.charCodeAt(index - 1)
  const isLowSurrogate = previousUnit >= 0xdc00 && previousUnit <= 0xdfff
  return codePointAt(line, isLowSurrogate ? index - 2 : index - 1)
}

/**
 * Whole-word filtering happens here rather than by wrapping the pattern in
 * boundary syntax: `(?:^|\W)` consumes the separator between adjacent matches
 * and widens the reported ranges, and `\b` cannot match a punctuation-edged
 * query at all. Matching VS Code, an edge counts as a boundary when it touches
 * the line edge, its neighbour is not a word character, or the match's own edge
 * character is not a word character.
 */
function isWholeWordRange(line: string, range: ProjectContentMatchRange): boolean {
  if (range.end <= range.start) return false
  const leftIsBoundary =
    range.start === 0 ||
    !isWord(codePointBefore(line, range.start)) ||
    !isWord(codePointAt(line, range.start))
  const rightIsBoundary =
    range.end >= line.length ||
    !isWord(codePointAt(line, range.end)) ||
    !isWord(codePointBefore(line, range.end))
  return leftIsBoundary && rightIsBoundary
}

/**
 * The engine reports byte offsets into the matched line; the renderer slices
 * the line as a JS string. Without this conversion every highlight after a
 * non-ASCII character on the same line lands short.
 */
function toStringRanges(line: string, byteRanges: readonly (readonly [number, number])[]): ProjectContentMatchRange[] {
  const lineBytes = Buffer.from(line)
  const toStringIndex = (byteOffset: number) => lineBytes.subarray(0, byteOffset).toString().length
  return byteRanges.map(([startByte, endByte]) => ({
    start: toStringIndex(startByte),
    end: toStringIndex(endByte),
  }))
}

/**
 * Case-insensitivity rides on the engine's smart case in plain mode: an
 * all-lowercase needle matches case-insensitively. Regex mode has no smart
 * case, so it needs the inline flag instead.
 */
function buildQuery(request: ProjectContentSearchRequest): ContentQuery {
  if (request.caseSensitive) return { query: request.query, regexMode: request.useRegex }
  return request.useRegex
    ? { query: `(?i)${request.query}`, regexMode: true }
    : { query: request.query.toLowerCase(), regexMode: false }
}

export async function searchProjectContents(
  root: string,
  request: ProjectContentSearchRequest,
): Promise<ProjectContentSearchResult> {
  if (!request.query) return { ok: true, matches: [], truncated: false }

  const finder = await getContentFinder(root)
  if (!finder) return { ok: false, error: 'Content search is unavailable for this project.' }

  const { query, regexMode } = buildQuery(request)
  const deadline = Date.now() + TIME_BUDGET_MS
  // Grep cursors advance a whole file at a time, so whole-word post-filtering
  // needs enough raw candidates from the current file before moving on.
  const rawPageSize = request.wholeWord
    ? Math.max(CONTENT_SEARCH_MAX_MATCHES, MAX_MATCHES_PER_FILE)
    : CONTENT_SEARCH_MAX_MATCHES

  const matches: ProjectContentMatch[] = []
  let cursor: GrepCursor | null = null
  let regexError: string | undefined

  do {
    const remainingMs = Math.max(1, deadline - Date.now())
    const result = finder.grep(query, {
      mode: regexMode ? 'regex' : 'plain',
      smartCase: !request.caseSensitive && !regexMode,
      maxMatchesPerFile: Math.min(MAX_MATCHES_PER_FILE, rawPageSize),
      pageSize: rawPageSize,
      cursor,
      timeBudgetMs: remainingMs,
    })
    if (!result.ok) {
      log.warn('content_search_grep_failed', { root, error: String(result.error) })
      return { ok: false, error: 'Search failed.' }
    }

    for (const item of result.value.items) {
      const ranges = toStringRanges(item.lineContent, item.matchRanges).filter(
        (range) => !request.wholeWord || isWholeWordRange(item.lineContent, range),
      )
      if (ranges.length === 0) continue
      matches.push({
        path: item.relativePath.replaceAll('\\', '/'),
        lineNumber: item.lineNumber,
        lineContent: item.lineContent,
        matchRanges: ranges,
      })
    }
    cursor = result.value.nextCursor
    regexError ??= result.value.regexFallbackError
  } while (matches.length < CONTENT_SEARCH_MAX_MATCHES && cursor !== null && Date.now() < deadline)

  const result: ProjectContentSearchResult = {
    ok: true,
    matches: matches.slice(0, CONTENT_SEARCH_MAX_MATCHES),
    truncated: matches.length > CONTENT_SEARCH_MAX_MATCHES || cursor !== null,
  }
  if (regexError !== undefined) result.regexError = regexError
  return result
}
