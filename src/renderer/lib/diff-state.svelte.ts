import { GIT_DIFF_FILE_BREAK_REGEX, parsePatchFiles, processFile, type FileDiffMetadata } from '@pierre/diffs'
import { FULL_CONTEXT_LINES, type DiffResult, type DiffScope, type IpcContext } from '../../shared/types'
import type { WorkspaceContext } from '../contexts'
import { buildExpandableMetadata, fileVersionsFromFullContext, type FileVersions } from './diff-expandable'

interface DiffStateOptions {
  session: WorkspaceContext
  getTabId: () => string
  getCtx?: () => IpcContext
}

export interface DiffLoadResult {
  result: DiffResult | null
  error: string | null
}

function scopeKey(scope: DiffScope): string {
  if (scope.kind === 'session') return 'session'
  if (scope.kind === 'working-tree') return 'working-tree'
  if (scope.kind === 'pr') return `pr:${scope.baseSha}:${scope.ownDeltaBaseSha ?? 'target'}`
  return `turn:${scope.index}`
}

type ParsedDiffScope = {
  patch: string
  files: FileDiffMetadata[]
  byPath: Map<string, FileDiffMetadata>
  binaryPaths: Set<string>
  hasGitBinaryPatch: boolean
}

// Paths flagged by git's `Binary files a/… and b/<path> differ` line. Kept as a
// module-level compiled regex (reset before each scan) so a live refresh never
// recompiles it. Mirrors the per-path check isBinaryFile used to build inline.
const BINARY_FILE_LINE = /^Binary files (?:a\/[^\n]+|\/dev\/null) and b\/(.+) differ$/gm

// A full-context patch carries every line of every changed file, so past this
// many files the second round trip costs more than expandable gaps are worth.
// Above the cap the diff simply keeps its non-expandable separators.
const MAX_EXPANDABLE_FILES = 300

function collectBinaryFiles(patch: string): { paths: Set<string>; hasGitBinaryPatch: boolean } {
  const paths = new Set<string>()
  BINARY_FILE_LINE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BINARY_FILE_LINE.exec(patch)) !== null) paths.add(match[1])
  return { paths, hasGitBinaryPatch: patch.includes('GIT binary patch') }
}

type DiffLineRange = {
  startLine: number
  endLine: number
  side: 'old' | 'new'
}

export interface DiffFindMatch {
  path: string
  side: 'old' | 'new'
  lineNo: number
  matchStart: number
  matchLength: number
}

export class DiffState {
  diff = $state<DiffResult | null>(null)
  loading = $state(true)
  loadError = $state<string | null>(null)
  scope = $state<DiffScope>({ kind: 'session' })
  patch = $state('')
  // raw, not deep $state: these parsed objects are replaced wholesale (never
  // mutated in place) and are handed to @pierre/diffs, which posts them to its
  // Shiki tokenizer worker. A deep $state proxy can't be structuredClone'd, so
  // postMessage throws DataCloneError and off-thread highlighting silently fails.
  fileDiffs = $state.raw<FileDiffMetadata[]>([])

  private generation = 0
  private currentByPath = new Map<string, FileDiffMetadata>()
  private currentBinaryPaths = new Set<string>()
  private currentHasGitBinaryPatch = false
  private parsedByScope = new Map<string, ParsedDiffScope>()
  // Per-file parse reuse across live refreshes: a mid-turn refresh re-emits the
  // whole multi-file patch but usually only one file's chunk text changed, so we
  // keep the previous parse keyed by exact `diff --git` chunk text and reparse
  // only the files that actually changed. Rebuilt each parse → bounded to the
  // current file set.
  private fileChunkCache = new Map<string, FileDiffMetadata>()
  // Per-file metadata rebuilt against full file contents, so @pierre/diffs will
  // let the reader expand the unchanged gaps between hunks. Keyed
  // `${scopeKey}\0${chunk}` like the reuse cache above, so a live mid-turn
  // refresh re-applies the upgrade to untouched files and only the files whose
  // chunk actually changed need a new full-context fetch. `null` records a file
  // we tried and couldn't upgrade (binary, mode-only, contents out of sync), so
  // we don't retry it every refresh.
  private expandableByChunk = new Map<string, FileDiffMetadata | null>()
  // Lazily-cached lowercased line arrays per file diff, so repeated find-in-diff
  // searches don't re-lowercase the whole diff on every keystroke. Weak-keyed on
  // the parsed file so it's GC'd (and, with chunk reuse, reused) automatically.
  private lowerCache = new WeakMap<FileDiffMetadata, { addition: string[]; deletion: string[] }>()

  constructor(private opts: DiffStateOptions) {}

  /**
   * Reload the diff. `silent` skips the loading state (no skeleton flash) and
   * keeps the last good diff if the background reload fails — used for live
   * mid-turn updates and the toolbar refresh button.
   */
  async refresh(scope?: DiffScope, opts: { silent?: boolean } = {}): Promise<DiffLoadResult> {
    if (scope) this.scope = scope
    const generation = ++this.generation
    if (!opts.silent) {
      this.loading = true
      this.loadError = null
    }

    const session = this.opts.session.sessionFor(this.opts.getTabId())
    const livePaths = session ? [...session.sessionChangedFiles] : undefined

    const requestScope = this.scope
    const response = await this.load(requestScope, livePaths)
    if (generation !== this.generation) return { result: null, error: null }

    if (opts.silent && !response.result) return response

    this.diff = response.result
    this.loadError = response.error
    if (response.result) {
      this.applyPatch(requestScope, response.result.patch)
      // Fire-and-forget: the panel renders on the normal patch, and the
      // expandable-gap upgrade swaps in when its own round trip lands. Only
      // RPC-backed scopes qualify — `setPatch` callers (the PR interdiff) have
      // no scope we can re-query.
      void this.loadExpandableContext(requestScope, response.result.patch, livePaths, generation)
    }

    this.loading = false

    return response
  }

  /** Load an already-computed unified patch through the same parser/rendering state as RPC-backed scopes. */
  setPatch(scope: DiffScope, patch: string): void {
    this.generation++
    this.scope = scope
    this.diff = { patch }
    this.loadError = null
    this.applyPatch(scope, patch)
    this.loading = false
  }

  isBinaryFile(path: string): boolean {
    return this.currentBinaryPaths.has(path) || this.currentHasGitBinaryPatch
  }

  selectedTextForRange(path: string, range: DiffLineRange): string {
    const out: string[] = []
    this.walkLines(path, ({ text, oldLineNo, newLineNo }) => {
      const lineNo = range.side === 'new' ? newLineNo : oldLineNo
      if (lineNo !== null && lineNo >= range.startLine && lineNo <= range.endLine) {
        out.push(text)
      }
    })
    return out.join('\n')
  }

  /**
   * Find every case-insensitive occurrence of `query` across the diff content,
   * walking files in `orderedPaths` order so navigation matches the on-screen
   * top-to-bottom stream order. Returns one entry per (non-overlapping) match.
   *
   * Side rule mirrors `scrollToLine`'s additions/deletions mapping: target the
   * 'new' side whenever a `newLineNo` exists (context + additions), else 'old'
   * (pure deletions).
   */
  findMatches(query: string, orderedPaths: string[]): DiffFindMatch[] {
    const out: DiffFindMatch[] = []
    if (!query) return out
    const needle = query.toLowerCase()
    const len = needle.length
    for (const path of orderedPaths) {
      const fileDiff = this.currentByPath.get(path)
      if (!fileDiff) continue
      // Walk the pre-lowercased line arrays so `text` is already lowercased —
      // matches indexOf directly, no per-line re-lowercasing per keystroke.
      const lower = this.lowerLinesFor(fileDiff)
      this.walkFileLines(fileDiff, lower.addition, lower.deletion, ({ text, oldLineNo, newLineNo }) => {
        const side: 'old' | 'new' = newLineNo !== null ? 'new' : 'old'
        const lineNo = side === 'new' ? newLineNo : oldLineNo
        if (lineNo === null) return
        let idx = text.indexOf(needle)
        while (idx !== -1) {
          out.push({ path, side, lineNo, matchStart: idx, matchLength: len })
          idx = text.indexOf(needle, idx + len)
        }
      })
    }
    return out
  }

  private lowerLinesFor(fileDiff: FileDiffMetadata): { addition: string[]; deletion: string[] } {
    let cached = this.lowerCache.get(fileDiff)
    if (!cached) {
      cached = {
        addition: fileDiff.additionLines.map((line) => line.toLowerCase()),
        deletion: fileDiff.deletionLines.map((line) => line.toLowerCase()),
      }
      this.lowerCache.set(fileDiff, cached)
    }
    return cached
  }

  dispose(): void {
    this.generation++
    this.resetLoadedState()
  }

  private resetLoadedState(): void {
    this.diff = null
    this.loading = true
    this.loadError = null
    this.patch = ''
    this.fileDiffs = []
    this.currentByPath = new Map()
    this.currentBinaryPaths = new Set()
    this.currentHasGitBinaryPatch = false
    this.fileChunkCache = new Map()
    this.expandableByChunk = new Map()
    this.parsedByScope.clear()
  }

  private async load(
    scope: DiffScope,
    livePaths: string[] | undefined,
    contextLines?: number,
  ): Promise<DiffLoadResult> {
    try {
      const result = await window.solus.diff(
        this.opts.getCtx?.() ?? this.opts.session.ctxFor(this.opts.getTabId()),
        { scope: { ...scope }, livePaths, contextLines },
      )
      return { result, error: null }
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Fetch the same patch with full context and re-parse each file against the
   * file contents it reconstructs, so the gaps between hunks become expandable.
   * See `diff-expandable.ts` for why this is a second `git diff` rather than a
   * blob fetch. Files that can't be upgraded keep their patch-only parse and
   * simply stay non-expandable — the feature degrades per file.
   */
  private async loadExpandableContext(
    scope: DiffScope,
    patch: string,
    livePaths: string[] | undefined,
    generation: number,
  ): Promise<void> {
    if (!patch.startsWith('diff --git')) return
    const key = scopeKey(scope)
    const chunks = patch.split(GIT_DIFF_FILE_BREAK_REGEX).filter((chunk) => chunk.startsWith('diff --git'))
    if (chunks.length === 0 || chunks.length > MAX_EXPANDABLE_FILES) return
    // Every file already resolved (upgraded or known-unupgradable) on a previous
    // pass — a live refresh that changed nothing must not re-fetch the world.
    if (chunks.every((chunk) => this.expandableByChunk.has(`${key}\0${chunk}`))) return

    const response = await this.load(scope, livePaths, FULL_CONTEXT_LINES)
    if (generation !== this.generation || !response.result) return
    const parsed = this.parsedByScope.get(key)
    if (!parsed || parsed.patch !== patch) return

    const versionsByPath = new Map<string, FileVersions>()
    for (const chunk of response.result.patch.split(GIT_DIFF_FILE_BREAK_REGEX)) {
      if (!chunk.startsWith('diff --git')) continue
      const file = processFile(chunk, { isGitDiff: true })
      const versions = file && fileVersionsFromFullContext(file)
      if (file && versions) versionsByPath.set(file.name, versions)
    }

    // Rebuilt fresh each pass, so the cache stays bounded to the current file set.
    const nextExpandable = new Map<string, FileDiffMetadata | null>()
    const upgradedByName = new Map<string, FileDiffMetadata>()
    for (const chunk of chunks) {
      const cacheKey = `${key}\0${chunk}`
      let upgraded = this.expandableByChunk.get(cacheKey)
      if (upgraded === undefined) {
        const partial = this.fileChunkCache.get(chunk)
        const versions = partial && versionsByPath.get(partial.name)
        upgraded = partial && versions ? buildExpandableMetadata(chunk, partial, versions) : null
      }
      nextExpandable.set(cacheKey, upgraded)
      if (upgraded) upgradedByName.set(upgraded.name, upgraded)
    }
    this.expandableByChunk = nextExpandable
    if (upgradedByName.size === 0) return

    const files = parsed.files.map((file) => upgradedByName.get(file.name) ?? file)
    const byPath = new Map(files.map((file) => [file.name, file]))
    this.parsedByScope.set(key, { ...parsed, files, byPath })
    this.fileDiffs = files
    this.currentByPath = byPath
  }

  private applyPatch(scope: DiffScope, patch: string): void {
    const key = scopeKey(scope)
    this.patch = patch
    let parsed = this.parsedByScope.get(key)
    if (!parsed || parsed.patch !== patch) {
      const files = this.parsePatchReusingFiles(patch, key)
      const { paths, hasGitBinaryPatch } = collectBinaryFiles(patch)
      parsed = {
        patch,
        files,
        byPath: new Map(files.map((fileDiff) => [fileDiff.name, fileDiff])),
        binaryPaths: paths,
        hasGitBinaryPatch,
      }
      this.parsedByScope.set(key, parsed)
    }
    this.fileDiffs = parsed.files
    this.currentByPath = parsed.byPath
    this.currentBinaryPaths = parsed.binaryPaths
    this.currentHasGitBinaryPatch = parsed.hasGitBinaryPatch
  }

  /**
   * Parse a whole `git diff` patch into per-file metadata, reusing the previous
   * refresh's parse for any file whose `diff --git` chunk text is byte-identical.
   * Git diffs split cleanly at `diff --git` boundaries with no cross-file state,
   * so parsing each chunk with `processFile` is exactly equivalent to
   * `parsePatchFiles` over the whole string — but skips reparsing untouched files
   * on a live mid-turn refresh. Anything that isn't a plain leading-`diff --git`
   * patch (e.g. format-patch commit metadata) falls back to the whole-patch
   * parse, preserving exact semantics. A file already upgraded to full-context
   * (expandable) metadata is reused from that cache first, so a live refresh
   * doesn't drop expansion on the files it didn't touch.
   */
  private parsePatchReusingFiles(patch: string, key: string): FileDiffMetadata[] {
    if (!patch.startsWith('diff --git')) {
      this.fileChunkCache = new Map()
      return parsePatchFiles(patch).flatMap((parsedPatch) => parsedPatch.files)
    }
    const nextCache = new Map<string, FileDiffMetadata>()
    const files: FileDiffMetadata[] = []
    for (const chunk of patch.split(GIT_DIFF_FILE_BREAK_REGEX)) {
      if (!chunk.startsWith('diff --git')) continue
      let file = this.expandableByChunk.get(`${key}\0${chunk}`) ?? this.fileChunkCache.get(chunk)
      if (!file) {
        file = processFile(chunk, { isGitDiff: true })
        if (!file) continue
      }
      nextCache.set(chunk, file)
      files.push(file)
    }
    this.fileChunkCache = nextCache
    return files
  }

  private walkLines(
    path: string,
    visit: (line: { text: string; oldLineNo: number | null; newLineNo: number | null }) => void,
  ): void {
    const fileDiff = this.currentByPath.get(path)
    if (!fileDiff) return
    this.walkFileLines(fileDiff, fileDiff.additionLines, fileDiff.deletionLines, visit)
  }

  // Walk a file's diff lines against caller-supplied addition/deletion arrays —
  // the raw arrays for text, or their lowercased twins for find. Line numbers
  // come from the hunk structure and are independent of the array contents.
  private walkFileLines(
    fileDiff: FileDiffMetadata,
    additionLines: string[],
    deletionLines: string[],
    visit: (line: { text: string; oldLineNo: number | null; newLineNo: number | null }) => void,
  ): void {
    for (const hunk of fileDiff.hunks) {
      let oldLine = hunk.deletionStart
      let newLine = hunk.additionStart
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let i = 0; i < content.lines; i++) {
            visit({
              text: additionLines[content.additionLineIndex + i] ??
                deletionLines[content.deletionLineIndex + i] ??
                '',
              oldLineNo: oldLine,
              newLineNo: newLine,
            })
            oldLine++
            newLine++
          }
        } else {
          for (let i = 0; i < content.deletions; i++) {
            visit({
              text: deletionLines[content.deletionLineIndex + i] ?? '',
              oldLineNo: oldLine,
              newLineNo: null,
            })
            oldLine++
          }
          for (let i = 0; i < content.additions; i++) {
            visit({
              text: additionLines[content.additionLineIndex + i] ?? '',
              oldLineNo: null,
              newLineNo: newLine,
            })
            newLine++
          }
        }
      }
    }
  }
}
