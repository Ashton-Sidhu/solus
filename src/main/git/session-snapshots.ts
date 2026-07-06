import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createLogger } from '../logger'
import { runAsync } from './exec'
import type { ChangedFileStat, DiffResult, DiffScope, TurnSnapshot } from '../../shared/types'

const log = createLogger('SessionSnapshots', 'session-snapshots.ts')

const SNAPSHOT_AUTHOR_NAME = 'Solus Snapshot'
const SNAPSHOT_AUTHOR_EMAIL = 'snapshot@solus.local'

interface Sidecar {
  baseSha: string
  turns: TurnSnapshot[]
}

function refForBase(sessionId: string): string {
  return `refs/solus/sessions/${sessionId}/base`
}

function refForTurn(sessionId: string, index: number): string {
  return `refs/solus/sessions/${sessionId}/turns/${index}`
}

function solusDir(repoRoot: string): string {
  return join(repoRoot, '.git', 'solus')
}

function sidecarPath(repoRoot: string, sessionId: string): string {
  return join(solusDir(repoRoot), 'sessions', `${sessionId}.json`)
}

function tmpIndexPath(repoRoot: string): string {
  return join(solusDir(repoRoot), `tmp-index-${randomUUID()}`)
}

function ensureSolusDirs(repoRoot: string): void {
  const dir = join(solusDir(repoRoot), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readSidecar(repoRoot: string, sessionId: string): Sidecar | null {
  try {
    const raw = readFileSync(sidecarPath(repoRoot, sessionId), 'utf-8')
    return JSON.parse(raw) as Sidecar
  } catch {
    return null
  }
}

/** The episode base SHA captured at session start — stable across commits
 *  within the session, so safe to key a review episode on. */
export function getSessionBaseSha(repoRoot: string, sessionId: string): string | null {
  return readSidecar(repoRoot, sessionId)?.baseSha ?? null
}

function writeSidecar(repoRoot: string, sessionId: string, data: Sidecar): void {
  ensureSolusDirs(repoRoot)
  writeFileSync(sidecarPath(repoRoot, sessionId), JSON.stringify(data, null, 2))
}

export async function initSessionBase(repoRoot: string, sessionId: string, baseSha: string): Promise<void> {
  if (!sessionId || !baseSha) return
  const ref = refForBase(sessionId)
  try {
    const existing = await runAsync('git', ['rev-parse', '--verify', '--quiet', ref], repoRoot)
    if (existing) return
  } catch {
    /* ref missing — proceed */
  }
  await runAsync('git', ['update-ref', ref, baseSha], repoRoot)
  ensureSolusDirs(repoRoot)
  if (!readSidecar(repoRoot, sessionId)) {
    writeSidecar(repoRoot, sessionId, { baseSha, turns: [] })
  }
}

async function resolvePrev(repoRoot: string, sessionId: string, turnIndex: number): Promise<{ commit: string; tree: string } | null> {
  const ref = turnIndex === 0 ? refForBase(sessionId) : refForTurn(sessionId, turnIndex - 1)
  try {
    const commit = await runAsync('git', ['rev-parse', '--verify', ref], repoRoot)
    const tree = await runAsync('git', ['rev-parse', `${commit}^{tree}`], repoRoot)
    return { commit, tree }
  } catch {
    return null
  }
}

async function diffStats(repoRoot: string, fromCommit: string, toCommit: string): Promise<{ filesChanged: number; additions: number; deletions: number }> {
  if (fromCommit === toCommit) return { filesChanged: 0, additions: 0, deletions: 0 }
  try {
    const out = await runAsync('git', ['diff', '--numstat', `${fromCommit}..${toCommit}`], repoRoot)
    const lines = out.split('\n').filter(Boolean)
    let additions = 0
    let deletions = 0
    for (const line of lines) {
      const parts = line.split('\t')
      additions += parseInt(parts[0], 10) || 0
      deletions += parseInt(parts[1], 10) || 0
    }
    return { filesChanged: lines.length, additions, deletions }
  } catch {
    return { filesChanged: 0, additions: 0, deletions: 0 }
  }
}

export interface SnapshotOpts {
  partial?: boolean
  userMessagePreview?: string
  /** Files this session modified. When provided, only these paths are staged
   *  instead of the full working tree — prevents cross-session leakage when
   *  multiple sessions share the same branch. */
  changedFiles?: string[]
}

export async function snapshotTurn(
  workTree: string,
  repoRoot: string,
  sessionId: string,
  opts: SnapshotOpts = {},
): Promise<TurnSnapshot | null> {
  const sidecar = readSidecar(repoRoot, sessionId)
  if (!sidecar) {
    log.warn(`Cannot snapshot — no base ref for session ${sessionId}`)
    return null
  }
  const turnIndex = sidecar.turns.length
  const prev = await resolvePrev(repoRoot, sessionId, turnIndex)
  if (!prev) {
    log.warn(`Cannot snapshot — previous ref missing for session ${sessionId} turn ${turnIndex}`)
    return null
  }

  ensureSolusDirs(repoRoot)
  const tmpIndex = tmpIndexPath(repoRoot)
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIndex }
  const treeArgs = [`--git-dir=${join(repoRoot, '.git')}`, `--work-tree=${workTree}`]

  try {
    await runAsync('git', [...treeArgs, 'read-tree', prev.tree], repoRoot, { env: indexEnv })

    if (opts.changedFiles) {
      for (const file of opts.changedFiles) {
        try {
          await runAsync('git', [...treeArgs, 'add', '--', file], repoRoot, { env: indexEnv })
        } catch {
          // File may have been deleted or moved — ignore
        }
      }
    } else {
      await runAsync('git', [...treeArgs, 'add', '-A'], repoRoot, { env: indexEnv })
    }

    const treeSha = await runAsync('git', [...treeArgs, 'write-tree'], repoRoot, { env: indexEnv })

    const commitEnv: NodeJS.ProcessEnv = {
      ...indexEnv,
      GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
    }
    const message = `solus-snapshot sid=${sessionId} turn=${turnIndex}${opts.partial ? ' partial' : ''}`
    const commitSha = await runAsync('git', 
      [...treeArgs, 'commit-tree', treeSha, '-p', prev.commit, '-m', message],
      repoRoot,
      { env: commitEnv },
    )
    await runAsync('git', ['update-ref', refForTurn(sessionId, turnIndex), commitSha], repoRoot)

    const stats = await diffStats(repoRoot, prev.commit, commitSha)
    const snap: TurnSnapshot = {
      index: turnIndex,
      sha: commitSha,
      timestamp: Date.now(),
      partial: !!opts.partial,
      userMessagePreview: opts.userMessagePreview ?? '',
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
    }
    sidecar.turns.push(snap)
    writeSidecar(repoRoot, sessionId, sidecar)
    return snap
  } catch (err) {
    log.error(`snapshotTurn failed sid=${sessionId} turn=${turnIndex}: ${err}`)
    return null
  } finally {
    try { unlinkSync(tmpIndex) } catch { /* best-effort */ }
  }
}

async function resolveScope(repoRoot: string, sessionId: string, scope: DiffScope): Promise<{ from: string; to: string } | null> {
  const sidecar = readSidecar(repoRoot, sessionId)
  if (!sidecar) return null
  let baseSha: string
  try {
    baseSha = await runAsync('git', ['rev-parse', '--verify', refForBase(sessionId)], repoRoot)
  } catch {
    return null
  }
  if (scope.kind === 'session') {
    if (sidecar.turns.length === 0) return { from: baseSha, to: baseSha }
    const latest = sidecar.turns[sidecar.turns.length - 1]
    return { from: baseSha, to: latest.sha }
  }
  if (scope.kind !== 'turn') return null
  const turn = sidecar.turns.find(t => t.index === scope.index)
  if (!turn) return null
  const fromSha = scope.index === 0
    ? baseSha
    : sidecar.turns.find(t => t.index === scope.index - 1)?.sha ?? baseSha
  return { from: fromSha, to: turn.sha }
}

// Keep each batched `git add` argv comfortably under the OS arg-length limit —
// a single turn can touch thousands of paths.
const PATHSPEC_CHUNK_CHARS = 100_000

function chunkPathspecs(paths: string[]): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let size = 0
  for (const path of paths) {
    if (current.length > 0 && size + path.length + 1 > PATHSPEC_CHUNK_CHARS) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(path)
    size += path.length + 1
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Stage each live path's current worktree state into the temp index. One batched
 * `git add` (chunked under the arg-length limit) replaces the per-path spawn that
 * dominated live-refresh latency. A path that no longer matches — created then
 * deleted within the session, or gitignored — makes a batched add abort *before*
 * it writes the index, so we fall back to the original resilient per-path loop,
 * which re-derives the identical index from the still-intact base tree (add
 * stages edits/deletions of matched paths; rm --cached drops paths that vanished).
 * The env — carrying the temp GIT_INDEX_FILE — is passed through exactly as the
 * per-path calls did.
 */
async function stageLivePaths(
  treeArgs: string[],
  livePaths: string[],
  repoRoot: string,
  indexEnv: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    for (const chunk of chunkPathspecs(livePaths)) {
      await runAsync('git', [...treeArgs, 'add', '--', ...chunk], repoRoot, { env: indexEnv })
    }
    return
  } catch {
    /* fall through to the per-path loop below */
  }
  for (const file of livePaths) {
    try {
      await runAsync('git', [...treeArgs, 'add', '--', file], repoRoot, { env: indexEnv })
    } catch {
      try {
        await runAsync('git', [...treeArgs, 'rm', '--cached', '--ignore-unmatch', '--', file], repoRoot, { env: indexEnv })
      } catch {
        /* best-effort */
      }
    }
  }
}

async function buildLiveTree(
  workTree: string,
  repoRoot: string,
  sessionId: string,
  livePaths: string[],
): Promise<{ baseSha: string; treeSha: string; cleanup: () => void } | null> {
  const sidecar = readSidecar(repoRoot, sessionId)
  if (!sidecar || livePaths.length === 0) return null

  let baseSha: string
  try {
    baseSha = await runAsync('git', ['rev-parse', '--verify', refForBase(sessionId)], repoRoot)
  } catch {
    return null
  }

  ensureSolusDirs(repoRoot)
  const tmpIndex = tmpIndexPath(repoRoot)
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIndex }
  const treeArgs = [`--git-dir=${join(repoRoot, '.git')}`, `--work-tree=${workTree}`]

  try {
    const baseTree = await runAsync('git', ['rev-parse', `${baseSha}^{tree}`], repoRoot)
    await runAsync('git', [...treeArgs, 'read-tree', baseTree], repoRoot, { env: indexEnv })
    await stageLivePaths(treeArgs, livePaths, repoRoot, indexEnv)
    const treeSha = await runAsync('git', [...treeArgs, 'write-tree'], repoRoot, { env: indexEnv })
    return {
      baseSha,
      treeSha,
      cleanup: () => {
        try { unlinkSync(tmpIndex) } catch { /* best-effort */ }
      },
    }
  } catch (err) {
    try { unlinkSync(tmpIndex) } catch { /* best-effort */ }
    log.error(`buildLiveTree failed sid=${sessionId}: ${err}`)
    return null
  }
}

// A whole-working-tree diff can be many MB — well past Node's 1 MiB stdout
// default. Sized generously so a large diff never silently truncates.
const COMBINED_DIFF_MAX_BUFFER = 256 * 1024 * 1024

// Explicit prefixes + quotepath off keep renderer-side @pierre/diffs parsing
// stable against the user's gitconfig.
const DIFF_FORMAT_ARGS = ['--no-ext-diff', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/']

const EMPTY_DIFF: DiffResult = { patch: '' }

/**
 * Seed a throwaway index from HEAD and intent-to-add every untracked file, so a
 * single `git diff HEAD` surfaces tracked edits AND untracked files (as new
 * files with full content) without touching the user's real index. Runs in the
 * worktree's own git context so HEAD resolves to its checked-out branch.
 */
async function withWorkingTreeIndex<T>(
  workTree: string,
  repoRoot: string,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  ensureSolusDirs(repoRoot)
  const tmpIndex = tmpIndexPath(repoRoot)
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIndex }
  try {
    await runAsync('git', ['read-tree', 'HEAD'], workTree, { env })
    await runAsync('git', ['add', '-N', '--', '.'], workTree, { env })
    return await fn(env)
  } finally {
    try { unlinkSync(tmpIndex) } catch { /* best-effort */ }
  }
}

/**
 * Whole-episode diff: `baseSha` (branch divergence point) vs the live working
 * tree — so it captures committed-on-branch work AND uncommitted edits AND
 * untracked files in one patch. Reuses the working-tree intent-to-add index so
 * untracked files surface as additions, exactly like the working-tree scope.
 * Used by the review companion, which reviews the full branch change, not just
 * the uncommitted delta.
 */
export async function getEpisodeDiff(
  workTree: string,
  repoRoot: string,
  baseSha: string,
): Promise<DiffResult> {
  const combined = await withWorkingTreeIndex(workTree, repoRoot, (env) =>
    runAsync('git', 
      ['-c', 'core.quotepath=false', 'diff', baseSha, ...DIFF_FORMAT_ARGS],
      workTree,
      { env, maxBuffer: COMBINED_DIFF_MAX_BUFFER },
    ),
  )
  return { patch: combined }
}

/**
 * The changed-files tally for the whole-episode diff (`baseSha` vs the live
 * working tree), via `--numstat` so we never materialize the full patch just to
 * count per-file lines. Same intent-to-add index as `getEpisodeDiff`, so
 * untracked files surface as additions. Renamed paths arrive as
 * `prefix{old => new}suffix`; we resolve them to the new path for display.
 */
export async function getEpisodeNumstat(
  workTree: string,
  repoRoot: string,
  baseSha: string,
): Promise<ChangedFileStat[]> {
  const out = await withWorkingTreeIndex(workTree, repoRoot, (env) =>
    runAsync('git',
      ['-c', 'core.quotepath=false', 'diff', baseSha, '--numstat'],
      workTree,
      { env, maxBuffer: COMBINED_DIFF_MAX_BUFFER },
    ),
  )
  const files: ChangedFileStat[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    // Binary files report `-` for both counts; parseInt → NaN → 0.
    const additions = parseInt(parts[0], 10) || 0
    const deletions = parseInt(parts[1], 10) || 0
    files.push({ path: resolveNumstatPath(parts[2]), additions, deletions })
  }
  return files
}

/** Resolve a numstat rename path to the destination: `a/{b => c}/d` → `a/c/d`,
 *  `old.ts => new.ts` → `new.ts`; plain paths pass through. */
function resolveNumstatPath(raw: string): string {
  const brace = raw.match(/^(.*)\{.* => (.*)\}(.*)$/)
  if (brace) return `${brace[1]}${brace[2]}${brace[3]}`
  const arrow = raw.split(' => ')
  return arrow.length === 2 ? arrow[1] : raw
}

/**
 * The single diff entry point for every scope. Resolves the scope to one
 * combined raw `git diff` patch:
 *  - working-tree: HEAD vs the live filesystem (untracked included via add -N)
 *  - session live: base vs this session's in-progress paths (temp tree)
 *  - session/turn: base/prev snapshot vs the turn snapshot (committed trees)
 */
export async function getDiff(
  workTree: string | null,
  repoRoot: string,
  scope: DiffScope,
  sessionId: string | null,
  livePaths: string[],
): Promise<DiffResult | null> {
  if (scope.kind === 'working-tree') {
    if (!workTree) return null
    const combined = await withWorkingTreeIndex(workTree, repoRoot, (env) =>
      runAsync('git', 
        ['-c', 'core.quotepath=false', 'diff', 'HEAD', ...DIFF_FORMAT_ARGS],
        workTree,
        { env, maxBuffer: COMBINED_DIFF_MAX_BUFFER },
      ),
    )
    return { patch: combined }
  }

  // PR review: the worktree IS the PR head; diff it against the merge-base so the
  // patch is exactly the PR's change set (same engine as the review companion).
  if (scope.kind === 'pr') {
    if (!workTree) return null
    return getEpisodeDiff(workTree, repoRoot, scope.baseSha)
  }

  if (!sessionId) return null

  // Live session diff: uncommitted work scoped to the paths this session touched.
  if (scope.kind === 'session' && workTree && livePaths.length > 0) {
    const live = await buildLiveTree(workTree, repoRoot, sessionId, livePaths)
    if (live) {
      try {
        if (live.baseSha === live.treeSha) return EMPTY_DIFF
        return {
          patch: await runAsync('git',
            ['-c', 'core.quotepath=false', 'diff', live.baseSha, live.treeSha, ...DIFF_FORMAT_ARGS],
            repoRoot,
            { maxBuffer: COMBINED_DIFF_MAX_BUFFER },
          ),
        }
      } finally {
        live.cleanup()
      }
    }
    // Live tree unavailable — fall through to the committed snapshot diff.
  }

  const range = await resolveScope(repoRoot, sessionId, scope)
  if (!range) return null
  if (range.from === range.to) return EMPTY_DIFF
  return {
    patch: await runAsync('git',
      ['-c', 'core.quotepath=false', 'diff', range.from, range.to, ...DIFF_FORMAT_ARGS],
      repoRoot,
      { maxBuffer: COMBINED_DIFF_MAX_BUFFER },
    ),
  }
}

/** Working-tree insertion/deletion totals for the status bar — numstat only, so
 *  the (throttled, polled) status fetch never materializes full patch text.
 *  Untracked files included via the same intent-to-add temp index as getDiff. */
export async function getWorkingTreeStats(
  workTree: string,
  repoRoot: string,
): Promise<{ additions: number; deletions: number }> {
  return withWorkingTreeIndex(workTree, repoRoot, async (env) => {
    const out = await runAsync('git', ['diff', 'HEAD', '--numstat'], workTree, { env, maxBuffer: COMBINED_DIFF_MAX_BUFFER })
    let additions = 0
    let deletions = 0
    for (const line of out.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      additions += parseInt(parts[0], 10) || 0
      deletions += parseInt(parts[1], 10) || 0
    }
    return { additions, deletions }
  })
}

export async function listTurnSnapshots(repoRoot: string, sessionId: string): Promise<TurnSnapshot[]> {
  const sidecar = readSidecar(repoRoot, sessionId)
  return sidecar?.turns ?? []
}
