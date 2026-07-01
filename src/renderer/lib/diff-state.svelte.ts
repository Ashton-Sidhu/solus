import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import type { DiffResult, DiffScope } from '../../shared/types'
import type { WorkspaceContext } from '../contexts/workspace.context.svelte'

interface DiffStateOptions {
  session: WorkspaceContext
  getTabId: () => string
}

export interface DiffLoadResult {
  result: DiffResult | null
  error: string | null
}

function scopeKey(scope: DiffScope): string {
  if (scope.kind === 'session') return 'session'
  if (scope.kind === 'working-tree') return 'working-tree'
  if (scope.kind === 'pr') return `pr:${scope.baseSha}`
  return `turn:${scope.index}`
}

type ParsedDiffScope = {
  patch: string
  files: FileDiffMetadata[]
  byPath: Map<string, FileDiffMetadata>
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
  private parsedByScope = new Map<string, ParsedDiffScope>()

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
    const livePaths = session ? [...session.changedFiles] : undefined

    const requestScope = this.scope
    const response = await this.load(requestScope, livePaths)
    if (generation !== this.generation) return { result: null, error: null }

    if (opts.silent && !response.result) return response

    this.diff = response.result
    this.loadError = response.error
    if (response.result) this.applyPatch(requestScope, response.result.patch)

    this.loading = false

    return response
  }

  isBinaryFile(path: string): boolean {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^Binary files (?:a/[^\\n]+|/dev/null) and b/${escaped} differ$`, 'm').test(this.patch) ||
      this.patch.includes('GIT binary patch')
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
      this.walkLines(path, ({ text, oldLineNo, newLineNo }) => {
        const side: 'old' | 'new' = newLineNo !== null ? 'new' : 'old'
        const lineNo = side === 'new' ? newLineNo : oldLineNo
        if (lineNo === null) return
        const hay = text.toLowerCase()
        let idx = hay.indexOf(needle)
        while (idx !== -1) {
          out.push({ path, side, lineNo, matchStart: idx, matchLength: len })
          idx = hay.indexOf(needle, idx + len)
        }
      })
    }
    return out
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
    this.parsedByScope.clear()
  }

  private async load(scope: DiffScope, livePaths: string[] | undefined): Promise<DiffLoadResult> {
    try {
      const result = await window.solus.diff(
        this.opts.session.ctxFor(this.opts.getTabId()),
        { scope: { ...scope }, livePaths },
      )
      return { result, error: null }
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private applyPatch(scope: DiffScope, patch: string): void {
    const key = scopeKey(scope)
    this.patch = patch
    let parsed = this.parsedByScope.get(key)
    if (!parsed || parsed.patch !== patch) {
      const files = parsePatchFiles(patch).flatMap((parsedPatch) => parsedPatch.files)
      parsed = {
        patch,
        files,
        byPath: new Map(files.map((fileDiff) => [fileDiff.name, fileDiff])),
      }
      this.parsedByScope.set(key, parsed)
    }
    this.fileDiffs = parsed.files
    this.currentByPath = parsed.byPath
  }

  private walkLines(
    path: string,
    visit: (line: { text: string; oldLineNo: number | null; newLineNo: number | null }) => void,
  ): void {
    const fileDiff = this.currentByPath.get(path)
    if (!fileDiff) return
    for (const hunk of fileDiff.hunks) {
      let oldLine = hunk.deletionStart
      let newLine = hunk.additionStart
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let i = 0; i < content.lines; i++) {
            visit({
              text: fileDiff.additionLines[content.additionLineIndex + i] ??
                fileDiff.deletionLines[content.deletionLineIndex + i] ??
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
              text: fileDiff.deletionLines[content.deletionLineIndex + i] ?? '',
              oldLineNo: oldLine,
              newLineNo: null,
            })
            oldLine++
          }
          for (let i = 0; i < content.additions; i++) {
            visit({
              text: fileDiff.additionLines[content.additionLineIndex + i] ?? '',
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
