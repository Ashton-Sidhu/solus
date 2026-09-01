import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { lstat, readlink } from 'fs/promises'
import { join, resolve } from 'path'
import { createHash, randomUUID } from 'crypto'
import { createLogger } from '../logger'
import { isInsideRoot } from '../paths'
import { runAsync } from './exec'
import type {
  ChangedFileStat,
  DiffFileContent,
  DiffFileContentsRequest,
  DiffFileContentsResult,
  DiffResult,
  DiffScope,
  TurnSnapshot,
} from '@solus/contracts/types'

const log = createLogger('SessionSnapshots', 'session-snapshots.ts')

const SNAPSHOT_AUTHOR_NAME = 'Solus Snapshot'
const SNAPSHOT_AUTHOR_EMAIL = 'snapshot@solus.local'

interface Sidecar {
  baseSha: string
  turns: TurnSnapshot[]
  /** Tree captured by the latest turn (or the session base before turn 0). */
  latestTreeSha?: string
  /** Authoritative net paths from the base to the latest captured tree. */
  sessionChangedFiles?: string[]
  /** Live worktree tree captured immediately before the current turn starts. */
  pendingTurnTreeSha?: string
}

const snapshotQueueByRepo = new Map<string, Promise<void>>()

async function inSnapshotQueue<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const previous = snapshotQueueByRepo.get(repoRoot) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(task)
  const tail = run.then(() => {}, () => {})
  snapshotQueueByRepo.set(repoRoot, tail)
  try {
    return await run
  } finally {
    if (snapshotQueueByRepo.get(repoRoot) === tail) snapshotQueueByRepo.delete(repoRoot)
  }
}

function refForBase(sessionId: string): string {
  return `refs/solus/sessions/${sessionId}/base`
}

function refForTurn(sessionId: string, index: number): string {
  return `refs/solus/sessions/${sessionId}/turns/${index}`
}

function refForTurnRange(sessionId: string, index: number, boundary: 'from' | 'to'): string {
  return `refs/solus/sessions/${sessionId}/turn-ranges/${index}/${boundary}`
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
    // SAFETY: this sidecar is written only by this module from the Sidecar contract.
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

/** Stable endpoints for the latest completed session snapshot. Review guides
 * use this range instead of comparing the session base with the shared live
 * worktree, which may contain changes from other sessions. */
export function getSessionSnapshotRange(
  repoRoot: string,
  sessionId: string,
): { baseSha: string; headSha: string } | null {
  const sidecar = readSidecar(repoRoot, sessionId)
  if (!sidecar) return null
  return {
    baseSha: sidecar.baseSha,
    headSha: sidecar.turns.at(-1)?.sha ?? sidecar.baseSha,
  }
}

function writeSidecar(repoRoot: string, sessionId: string, data: Sidecar): void {
  ensureSolusDirs(repoRoot)
  // Machine-written, machine-read, and rewritten at every turn boundary — the
  // sidecar grows with session length, so serialize compact to keep the
  // event-loop cost of a turn snapshot flat.
  writeFileSync(sidecarPath(repoRoot, sessionId), JSON.stringify(data))
}

export async function initSessionBase(repoRoot: string, sessionId: string, baseSha: string): Promise<void> {
  return inSnapshotQueue(repoRoot, () => initSessionBaseQueued(repoRoot, sessionId, baseSha))
}

async function initSessionBaseQueued(repoRoot: string, sessionId: string, baseSha: string): Promise<void> {
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
    const latestTreeSha = await runAsync('git', ['rev-parse', `${baseSha}^{tree}`], repoRoot)
    writeSidecar(repoRoot, sessionId, {
      baseSha,
      turns: [],
      latestTreeSha,
      sessionChangedFiles: [],
    })
  }
}

async function resolvePrev(repoRoot: string, sidecar: Sidecar): Promise<{ commit: string; tree: string } | null> {
  const commit = sidecar.turns.at(-1)?.sha ?? sidecar.baseSha
  if (sidecar.latestTreeSha) return { commit, tree: sidecar.latestTreeSha }
  try {
    const tree = await runAsync('git', ['rev-parse', `${commit}^{tree}`], repoRoot)
    return { commit, tree }
  } catch {
    return null
  }
}

async function diffStats(repoRoot: string, fromTreeish: string, toTreeish: string): Promise<{ filesChanged: number; additions: number; deletions: number }> {
  if (fromTreeish === toTreeish) return { filesChanged: 0, additions: 0, deletions: 0 }
  try {
    const out = await runAsync('git', ['diff', '--numstat', fromTreeish, toTreeish], repoRoot)
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
  sessionChangedFiles?: string[]
  /** Files modified during this turn. This keeps the turn range narrower than
   *  the cumulative session path set. */
  turnChangedFiles?: string[]
}

export interface SnapshotTurnResult {
  snapshot: TurnSnapshot
  /** Files with a net change across the whole session after this snapshot. */
  sessionChangedFiles: string[] | null
}

/** Capture the live worktree immediately before a provider turn starts. The
 *  checkpoint is a Git tree, not a commit, and never touches the user's index. */
export async function prepareTurnSnapshot(
  workTree: string,
  repoRoot: string,
  sessionId: string,
): Promise<void> {
  return inSnapshotQueue(repoRoot, async () => {
    const sidecar = readSidecar(repoRoot, sessionId)
    if (!sidecar) return
    const headSha = await runAsync('git', ['rev-parse', 'HEAD'], workTree)
    const dirtyPaths = await listLiveChangedPaths(workTree)
    sidecar.pendingTurnTreeSha = await writeTreeForPaths(
      workTree,
      repoRoot,
      headSha,
      dirtyPaths,
    )
    writeSidecar(repoRoot, sessionId, sidecar)
  })
}

export async function snapshotTurn(
  workTree: string,
  repoRoot: string,
  sessionId: string,
  opts: SnapshotOpts = {},
): Promise<SnapshotTurnResult | null> {
  return inSnapshotQueue(repoRoot, () => snapshotTurnQueued(workTree, repoRoot, sessionId, opts))
}

async function snapshotTurnQueued(
  workTree: string,
  repoRoot: string,
  sessionId: string,
  opts: SnapshotOpts,
): Promise<SnapshotTurnResult | null> {
  const sidecar = readSidecar(repoRoot, sessionId)
  if (!sidecar) {
    log.warn('snapshot_skipped_no_base_ref', { sessionId })
    return null
  }
  if (!sidecar.pendingTurnTreeSha) {
    log.warn('snapshot_skipped_no_turn_start', { sessionId })
    return null
  }
  const turnIndex = sidecar.turns.length
  const prev = await resolvePrev(repoRoot, sidecar)
  if (!prev) {
    log.warn('snapshot_skipped_prev_ref_missing', { sessionId, turnIndex })
    return null
  }

  ensureSolusDirs(repoRoot)
  const tmpIndex = tmpIndexPath(repoRoot)
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIndex }
  const treeArgs = [`--git-dir=${join(repoRoot, '.git')}`, `--work-tree=${workTree}`]

  try {
    await runAsync('git', [...treeArgs, 'read-tree', prev.tree], repoRoot, { env: indexEnv })

    if (opts.sessionChangedFiles) {
      await stageLivePaths(treeArgs, opts.sessionChangedFiles, repoRoot, indexEnv)
    } else {
      await runAsync('git', [...treeArgs, 'add', '-A'], repoRoot, { env: indexEnv })
    }

    const treeSha = await runAsync('git', [...treeArgs, 'write-tree'], repoRoot, { env: indexEnv })
    const turnFrom = sidecar.pendingTurnTreeSha
    const turnTo = await writeTreeForPaths(
      workTree,
      repoRoot,
      turnFrom,
      opts.turnChangedFiles ?? opts.sessionChangedFiles ?? [],
    )
    const turnStats = await diffStats(repoRoot, turnFrom, turnTo)
    await Promise.all([
      runAsync('git', ['update-ref', refForTurnRange(sessionId, turnIndex, 'from'), turnFrom], repoRoot),
      runAsync('git', ['update-ref', refForTurnRange(sessionId, turnIndex, 'to'), turnTo], repoRoot),
    ])
    delete sidecar.pendingTurnTreeSha
    if (treeSha === prev.tree) {
      let sessionChangedFiles: string[] | null = sidecar.sessionChangedFiles ?? null
      if (!sessionChangedFiles && prev.commit === sidecar.baseSha) {
        sessionChangedFiles = []
      } else if (!sessionChangedFiles) {
        try {
          sessionChangedFiles = parseChangedFileStats(await runAsync('git', [
            '-c',
            'core.quotepath=false',
            'diff',
            sidecar.baseSha,
            prev.commit,
            '--numstat',
          ], repoRoot, { maxBuffer: COMBINED_DIFF_MAX_BUFFER })).map((file) => file.path)
        } catch (err) {
          log.warn('session_path_reconciliation_failed', { sessionId, turnIndex, error: err instanceof Error ? err.message : String(err) })
        }
      }
      const snap: TurnSnapshot = {
        index: turnIndex,
        fromTreeSha: turnFrom,
        toTreeSha: turnTo,
        sha: prev.commit,
        timestamp: Date.now(),
        partial: !!opts.partial,
        userMessagePreview: opts.userMessagePreview ?? '',
        filesChanged: turnStats.filesChanged,
        additions: turnStats.additions,
        deletions: turnStats.deletions,
      }
      sidecar.turns.push(snap)
      sidecar.latestTreeSha = treeSha
      if (sessionChangedFiles) sidecar.sessionChangedFiles = sessionChangedFiles
      writeSidecar(repoRoot, sessionId, sidecar)
      return { snapshot: snap, sessionChangedFiles }
    }

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

    const snap: TurnSnapshot = {
      index: turnIndex,
      fromTreeSha: turnFrom,
      toTreeSha: turnTo,
      sha: commitSha,
      timestamp: Date.now(),
      partial: !!opts.partial,
      userMessagePreview: opts.userMessagePreview ?? '',
      filesChanged: turnStats.filesChanged,
      additions: turnStats.additions,
      deletions: turnStats.deletions,
    }
    sidecar.turns.push(snap)
    let sessionChangedFiles: string[] | null = null
    try {
      const sessionStats = sidecar.baseSha === commitSha
        ? []
        : parseChangedFileStats(await runAsync('git', [
          '-c',
          'core.quotepath=false',
          'diff',
          sidecar.baseSha,
          commitSha,
          '--numstat',
        ], repoRoot, { maxBuffer: COMBINED_DIFF_MAX_BUFFER }))
      sessionChangedFiles = sessionStats.map((file) => file.path)
    } catch (err) {
      log.warn('session_path_reconciliation_failed', { sessionId, turnIndex, error: err instanceof Error ? err.message : String(err) })
    }
    sidecar.latestTreeSha = treeSha
    if (sessionChangedFiles) sidecar.sessionChangedFiles = sessionChangedFiles
    writeSidecar(repoRoot, sessionId, sidecar)
    return { snapshot: snap, sessionChangedFiles }
  } catch (err) {
    log.error('snapshot_turn_failed', { sessionId, turnIndex, error: err instanceof Error ? err.message : String(err) })
    return null
  } finally {
    try { unlinkSync(tmpIndex) } catch { /* best-effort */ }
  }
}

async function resolveScope(repoRoot: string, sessionId: string, scope: DiffScope): Promise<{ from: string; to: string } | null> {
  const sidecar = readSidecar(repoRoot, sessionId)
  if (!sidecar) return null
  if (scope.kind === 'session') {
    return {
      from: sidecar.baseSha,
      to: sidecar.turns.at(-1)?.sha ?? sidecar.baseSha,
    }
  }
  if (scope.kind !== 'turn') return null
  const turn = sidecar.turns.find(t => t.index === scope.index)
  if (!turn?.fromTreeSha || !turn.toTreeSha) return null
  return { from: turn.fromTreeSha, to: turn.toTreeSha }
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

async function listLiveChangedPaths(workTree: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runAsync('git', ['diff', 'HEAD', '--name-only', '-z'], workTree, { raw: true }),
    runAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], workTree, { raw: true }),
  ])
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))]
}

async function writeTreeForPaths(
  workTree: string,
  repoRoot: string,
  baseTreeish: string,
  paths: string[],
): Promise<string> {
  ensureSolusDirs(repoRoot)
  const indexPath = tmpIndexPath(repoRoot)
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath }
  const treeArgs = [`--git-dir=${join(repoRoot, '.git')}`, `--work-tree=${workTree}`]
  try {
    await runAsync('git', [...treeArgs, 'read-tree', baseTreeish], repoRoot, { env: indexEnv })
    await stageLivePaths(treeArgs, paths, repoRoot, indexEnv)
    return await runAsync('git', [...treeArgs, 'write-tree'], repoRoot, { env: indexEnv })
  } finally {
    try { unlinkSync(indexPath) } catch { /* best-effort */ }
  }
}

/**
 * True when the session works in its own linked worktree rather than the shared
 * checkout. There it owns every change in the tree, so the session scope is the
 * whole worktree against the session base: scoping to transcript-derived
 * `livePaths` can only drop files, because a shell write or a subagent edit
 * never produces the Write/Edit tool message those paths are harvested from. In
 * a shared checkout the filter still earns its place — other sessions and the
 * developer edit the same tree.
 */
function ownsWorkTree(workTree: string | null, repoRoot: string): workTree is string {
  return !!workTree && resolve(workTree) !== resolve(repoRoot)
}

/** The session base read through its ref, so a rewritten or collected base
 *  commit cannot strand the scope. */
async function resolveSessionBase(repoRoot: string, sessionId: string): Promise<string | null> {
  try {
    return await runAsync('git', ['rev-parse', '--verify', refForBase(sessionId)], repoRoot)
  } catch {
    return null
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

  const baseSha = await resolveSessionBase(repoRoot, sessionId)
  if (!baseSha) return null

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
    log.error('build_live_tree_failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// A whole-working-tree diff can be many MB — well past Node's 1 MiB stdout
// default. Sized generously so a large diff never silently truncates.
const COMBINED_DIFF_MAX_BUFFER = 256 * 1024 * 1024

// Explicit prefixes + quotepath off keep renderer-side @pierre/diffs parsing
// stable against the user's gitconfig.
function diffFormatArgs(): string[] {
  return ['--no-ext-diff', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/']
}

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
      ['-c', 'core.quotepath=false', 'diff', baseSha, ...diffFormatArgs()],
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
      ['-c', 'core.quotepath=false', 'diff', baseSha, '--numstat', '--summary'],
      workTree,
      { env, maxBuffer: COMBINED_DIFF_MAX_BUFFER },
    ),
  )
  return parseChangedFileStats(out)
}

/**
 * Parse `git diff --numstat --summary` output into the renderer's compact file
 * model. The numstat block carries the counts; the trailing summary block is the
 * only thing that says whether a file was created, deleted or renamed — anything
 * it does not name is a modification.
 */
export function parseChangedFileStats(out: string): ChangedFileStat[] {
  const files: ChangedFileStat[] = []
  const statuses = new Map<string, ChangedFileStat['status']>()
  for (const line of out.split('\n')) {
    if (!line) continue
    // Summary lines are the indented tail of the output; numstat lines are not.
    if (line.startsWith(' ')) {
      const summary = line.match(/^ (create|delete) mode \d+ (.*)$/)
      if (summary) {
        statuses.set(summary[2], summary[1] === 'create' ? 'A' : 'D')
        continue
      }
      const renamed = line.match(/^ rename (.*) \(\d+%\)$/)
      if (renamed) statuses.set(resolveNumstatPath(renamed[1]), 'R')
      continue
    }
    const parts = line.split('\t')
    if (parts.length < 3) continue
    // Binary files report `-` for both counts; parseInt → NaN → 0.
    const additions = parseInt(parts[0], 10) || 0
    const deletions = parseInt(parts[1], 10) || 0
    files.push({ path: resolveNumstatPath(parts[2]), additions, deletions, status: 'M' })
  }
  for (const file of files) {
    const status = statuses.get(file.path)
    if (status) file.status = status
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

/** Resolve a stacked comparison to the same merge-base semantics as a normal
 * PR diff. Stack detection fetches these objects into the shared repository;
 * the targeted fallback covers a cold worktree opened before that fetch. */
export async function resolvePrDiffBase(
  workTree: string,
  repoRoot: string,
  scope: Extract<DiffScope, { kind: 'pr' }>,
): Promise<string> {
  if (!scope.ownDeltaBaseSha) return scope.baseSha

  const parentHead = scope.ownDeltaBaseSha
  const available = await runAsync('git', ['rev-parse', '--verify', `${parentHead}^{commit}`], repoRoot)
    .then(() => true, () => false)
  if (!available && scope.parentPr) {
    const ref = `refs/solus/pr/${scope.parentPr}`
    await runAsync('git', ['fetch', 'origin', `pull/${scope.parentPr}/head:${ref}`], repoRoot)
    // The graph's SHA is the contract. If the parent moved remotely, do not
    // silently diff against the newly fetched head under the stale guide key.
    await runAsync('git', ['rev-parse', '--verify', `${parentHead}^{commit}`], repoRoot)
  }

  const childHead = await runAsync('git', ['rev-parse', '--verify', 'HEAD'], workTree)
  return runAsync('git', ['merge-base', parentHead, childHead], repoRoot)
}

/**
 * The single diff entry point for every scope. Resolves the scope to one
 * combined raw `git diff` patch:
 *  - working-tree: HEAD vs the live filesystem (untracked included via add -N)
 *  - session owned: base vs the whole worktree the session works alone in
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
        ['-c', 'core.quotepath=false', 'diff', 'HEAD', ...diffFormatArgs()],
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
    const base = await resolvePrDiffBase(workTree, repoRoot, scope)
    return getEpisodeDiff(workTree, repoRoot, base)
  }

  if (!sessionId) return null

  // Isolated worktree: the session owns the tree, so diff all of it against the
  // session base rather than the paths its transcript happens to name.
  if (scope.kind === 'session' && ownsWorkTree(workTree, repoRoot)) {
    const base = await resolveSessionBase(repoRoot, sessionId)
    if (base) return getEpisodeDiff(workTree, repoRoot, base)
  }

  // Live session diff: uncommitted work scoped to the paths this session touched.
  if (scope.kind === 'session' && workTree && livePaths.length > 0) {
    const live = await buildLiveTree(workTree, repoRoot, sessionId, livePaths)
    if (live) {
      try {
        if (live.baseSha === live.treeSha) return EMPTY_DIFF
        return {
          patch: await runAsync('git',
            ['-c', 'core.quotepath=false', 'diff', live.baseSha, live.treeSha, ...diffFormatArgs()],
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
      ['-c', 'core.quotepath=false', 'diff', range.from, range.to, ...diffFormatArgs()],
      repoRoot,
      { maxBuffer: COMBINED_DIFF_MAX_BUFFER },
    ),
  }
}

/** A blob that no longer matches the object id the rendered patch carried — the
 *  working tree moved under the request, so the content must not be returned.
 *  An absent or all-zero expectation (a new or deleted side) never goes stale. */
function isStaleFile(file: DiffFileContent | null, expected?: string): boolean {
  if (!file || !expected || /^0+$/.test(expected)) return false
  return !file.cacheKey.startsWith(expected)
}

async function readBlobAt(
  repoRoot: string,
  ref: string,
  path: string,
): Promise<DiffFileContent | null> {
  try {
    const objectId = await runAsync('git', ['rev-parse', '--verify', `${ref}:${path}`], repoRoot)
    const contents = await runAsync('git', ['cat-file', 'blob', objectId], repoRoot, {
      maxBuffer: COMBINED_DIFF_MAX_BUFFER,
      raw: true,
    })
    return { name: path, contents, cacheKey: objectId }
  } catch {
    return null
  }
}

async function readWorktreeFile(
  workTree: string,
  path: string,
): Promise<DiffFileContent | null> {
  const absolutePath = resolve(workTree, path)
  if (!isInsideRoot(workTree, absolutePath)) return null

  try {
    const fileStat = await lstat(absolutePath)
    if (fileStat.isSymbolicLink()) {
      const contents = await readlink(absolutePath)
      const objectFormat = await runAsync('git', ['rev-parse', '--show-object-format'], workTree)
      const bytes = Buffer.from(contents)
      const objectId = createHash(objectFormat)
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex')
      return { name: path, contents, cacheKey: objectId }
    }

    // `--path` applies the repository's clean filters (including autocrlf), so
    // the returned text and object id match the patch rather than raw disk bytes.
    // Writing the unreferenced blob lets cat-file return that canonical content.
    const objectId = await runAsync('git', ['hash-object', '-w', `--path=${path}`, '--', path], workTree)
    const contents = await runAsync('git', ['cat-file', 'blob', objectId], workTree, {
      maxBuffer: COMBINED_DIFF_MAX_BUFFER,
      raw: true,
    })
    return { name: path, contents, cacheKey: objectId }
  } catch {
    return null
  }
}

/**
 * Load just the two blobs needed to hydrate one partial diff. The comparison
 * endpoints mirror `getDiff` exactly, including session-isolated live trees.
 * Object ids from the displayed patch reject a response if the working tree
 * changed between rendering the patch and requesting expansion.
 */
export async function getDiffFileContents(
  workTree: string | null,
  repoRoot: string,
  sessionId: string | null,
  request: DiffFileContentsRequest,
): Promise<DiffFileContentsResult | null> {
  const oldPath = request.previousPath ?? request.path
  let oldFile: DiffFileContent | null
  let newFile: DiffFileContent | null

  if (request.scope.kind === 'working-tree') {
    if (!workTree) return null
    ;[oldFile, newFile] = await Promise.all([
      readBlobAt(repoRoot, 'HEAD', oldPath),
      readWorktreeFile(workTree, request.path),
    ])
  } else if (request.scope.kind === 'pr') {
    if (!workTree) return null
    const base = await resolvePrDiffBase(workTree, repoRoot, request.scope)
    ;[oldFile, newFile] = await Promise.all([
      readBlobAt(repoRoot, base, oldPath),
      readWorktreeFile(workTree, request.path),
    ])
  } else if (!sessionId) {
    return null
  } else if (request.scope.kind === 'session' && ownsWorkTree(workTree, repoRoot)) {
    // Isolated worktree: the session owns the tree, so read the live file
    // against the session base, exactly as `getDiff` renders it.
    const base = await resolveSessionBase(repoRoot, sessionId)
    if (!base) return null
    ;[oldFile, newFile] = await Promise.all([
      readBlobAt(repoRoot, base, oldPath),
      readWorktreeFile(workTree, request.path),
    ])
  } else {
    // Shared checkout, or a turn: both sides are blobs in captured trees — the
    // session's isolated temp tree when it has one, else the snapshot range.
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    const live = request.scope.kind === 'session' && workTree && livePaths.length > 0
      ? await buildLiveTree(workTree, repoRoot, sessionId, livePaths)
      : null
    const range = live
      ? { from: live.baseSha, to: live.treeSha }
      : await resolveScope(repoRoot, sessionId, request.scope)
    if (!range) return null
    try {
      ;[oldFile, newFile] = await Promise.all([
        readBlobAt(repoRoot, range.from, oldPath),
        readBlobAt(repoRoot, range.to, request.path),
      ])
    } finally {
      live?.cleanup()
    }
  }

  if (isStaleFile(oldFile, request.expectedOldObjectId) || isStaleFile(newFile, request.expectedNewObjectId)) {
    return null
  }
  return { oldFile, newFile }
}

/**
 * Per-file statistics for the same scopes as `getDiff`, without constructing or
 * transferring patch text. In a shared checkout the session-live path still uses
 * its isolated temp tree so files touched by another session cannot leak into
 * the result; in the session's own worktree there is nobody to leak from.
 */
export async function getDiffStats(
  workTree: string | null,
  repoRoot: string,
  scope: DiffScope,
  sessionId: string | null,
  livePaths: string[],
): Promise<ChangedFileStat[]> {
  if (scope.kind === 'working-tree') {
    if (!workTree) return []
    const out = await withWorkingTreeIndex(workTree, repoRoot, (env) =>
      runAsync('git', ['-c', 'core.quotepath=false', 'diff', 'HEAD', '--numstat', '--summary'], workTree, {
        env,
        maxBuffer: COMBINED_DIFF_MAX_BUFFER,
      }),
    )
    return parseChangedFileStats(out)
  }

  if (scope.kind === 'pr') {
    if (!workTree) return []
    return getEpisodeNumstat(workTree, repoRoot, await resolvePrDiffBase(workTree, repoRoot, scope))
  }

  if (!sessionId) return []

  if (scope.kind === 'session' && ownsWorkTree(workTree, repoRoot)) {
    const base = await resolveSessionBase(repoRoot, sessionId)
    if (base) return getEpisodeNumstat(workTree, repoRoot, base)
  }

  if (scope.kind === 'session' && workTree && livePaths.length > 0) {
    const live = await buildLiveTree(workTree, repoRoot, sessionId, livePaths)
    if (live) {
      try {
        if (live.baseSha === live.treeSha) return []
        const out = await runAsync('git',
          ['-c', 'core.quotepath=false', 'diff', live.baseSha, live.treeSha, '--numstat', '--summary'],
          repoRoot,
          { maxBuffer: COMBINED_DIFF_MAX_BUFFER },
        )
        return parseChangedFileStats(out)
      } finally {
        live.cleanup()
      }
    }
  }

  const range = await resolveScope(repoRoot, sessionId, scope)
  if (!range || range.from === range.to) return []
  const out = await runAsync('git',
    ['-c', 'core.quotepath=false', 'diff', range.from, range.to, '--numstat', '--summary'],
    repoRoot,
    { maxBuffer: COMBINED_DIFF_MAX_BUFFER },
  )
  return parseChangedFileStats(out)
}

/** Working-tree insertion/deletion totals for visible Git UI — numstat only, so
 *  a detailed status fetch never materializes full patch text.
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
