import { lstat } from 'fs/promises'
import { join } from 'path'
import { runAsync } from './exec'
import {
  changedPathsBetween,
  cleanTurnStartOf,
  getSessionSnapshotRange,
  initSessionBase,
  noteCleanTurnStart,
  prepareTurnSnapshot,
  restorePaths,
  sessionBaseCommit,
  snapshotLiveTree,
  snapshotTurn,
  type LateTurnStart,
  type SnapshotOpts,
  type SnapshotTurnResult,
} from './session-snapshots'

/**
 * The checkpoints of a turn in a session folder (docs/plans/codebases.md §8).
 * A codebase can have many repositories and a turn changes few of them, so a
 * repository that the turn left alone costs one status read at each end and
 * writes nothing:
 *
 * - At the turn start a clean checkout is only noted, with its commit. A
 *   checkout with changes gets a base and a tree, as the working directory does.
 * - At the turn end a checkout that is still clean at the noted commit is left
 *   alone. One that changed gets its base from the noted commit, then its
 *   snapshot.
 * - A checkout with no start in the turn (a folder attached in the turn, or one
 *   that missed the time budget of the turn start) shows the paths written
 *   after the turn started, each against the last captured state.
 */

/** What one status read says about a checkout. */
export interface CheckoutState {
  /** The commit `HEAD` names; null on a branch with no commit. */
  head: string | null
  /** No changed, staged, or untracked path. */
  clean: boolean
}

/** One `git status`: the cheapest read that tells whether a checkout changed. */
export async function readCheckoutState(workTree: string, signal?: AbortSignal): Promise<CheckoutState> {
  const out = await runAsync('git', ['status', '--porcelain=v2', '--branch', '-z'], workTree, { raw: true, signal })
  const state: CheckoutState = { head: null, clean: true }
  for (const entry of out.split('\0')) {
    if (!entry) continue
    if (!entry.startsWith('# ')) state.clean = false
    else if (entry.startsWith('# branch.oid ')) {
      const oid = entry.slice('# branch.oid '.length)
      state.head = oid === '(initial)' ? null : oid
    }
  }
  return state
}

/**
 * Take the start of a turn in a session folder. True when the start was taken
 * before `signal` stopped: a start that comes late can hold the first writes
 * of the turn, so it is not kept.
 */
export async function beginFolderTurn(workTree: string, repoRoot: string, sessionId: string, signal: AbortSignal): Promise<boolean> {
  noteCleanTurnStart(repoRoot, sessionId, null)
  const state = await readCheckoutState(workTree, signal)
  if (signal.aborted) return false
  if (state.clean && state.head) {
    noteCleanTurnStart(repoRoot, sessionId, state.head)
    return true
  }
  // Changes that were there before the turn stay out of it: capture them now.
  await initSessionBase(repoRoot, sessionId, await sessionBaseCommit(workTree, repoRoot), workTree)
  if (signal.aborted) return false
  return prepareTurnSnapshot(workTree, repoRoot, sessionId, signal)
}

export interface FolderTurnEnd {
  /** The snapshot of the turn; null when the turn wrote nothing in the repository. */
  result: SnapshotTurnResult | null
  /** The commit of a checkout that the turn left alone: clean there at both ends. */
  leftAloneAt: string | null
}

/**
 * Take the end of a turn in a session folder. `hasStart` is the answer of
 * `beginFolderTurn` for this turn; without a start, `turnStartedAt` tells the
 * writes of the turn from the older ones.
 */
export async function endFolderTurn(
  workTree: string,
  repoRoot: string,
  sessionId: string,
  hasStart: boolean,
  turnStartedAt: number,
  opts: SnapshotOpts,
): Promise<FolderTurnEnd> {
  const cleanStart = hasStart ? cleanTurnStartOf(repoRoot, sessionId) : null
  try {
    if (cleanStart) {
      const state = await readCheckoutState(workTree)
      if (state.clean && state.head === cleanStart) return { result: null, leftAloneAt: cleanStart }
      const treeSha = await runAsync('git', ['rev-parse', `${cleanStart}^{tree}`], repoRoot)
      return { result: await snapshotTurn(workTree, repoRoot, sessionId, opts, { baseSha: cleanStart, treeSha }), leftAloneAt: null }
    }
    if (hasStart) return { result: await snapshotTurn(workTree, repoRoot, sessionId, opts), leftAloneAt: null }
    const lateStart = await startFromWrites(workTree, repoRoot, sessionId, turnStartedAt)
    return { result: lateStart ? await snapshotTurn(workTree, repoRoot, sessionId, opts, lateStart) : null, leftAloneAt: null }
  } finally {
    noteCleanTurnStart(repoRoot, sessionId, null)
  }
}

/**
 * The start of a turn that left no start in the checkout: the live tree, with
 * each path written after the turn started put back as it was in the last
 * captured state (the session's latest snapshot, else `HEAD`). Null when no
 * path was written in the turn: nothing is recorded then. A path deleted in
 * the turn has no write time, so it stays out of the turn.
 */
async function startFromWrites(workTree: string, repoRoot: string, sessionId: string, turnStartedAt: number): Promise<LateTurnStart | null> {
  const known = getSessionSnapshotRange(repoRoot, sessionId)
  if (!known) {
    // A clean checkout that the session never changed has nothing to record.
    const state = await readCheckoutState(workTree)
    if (state.clean) return null
  }
  const baseSha = known?.baseSha ?? await sessionBaseCommit(workTree, repoRoot)
  const knownTree = await runAsync('git', ['rev-parse', `${known?.headSha ?? baseSha}^{tree}`], repoRoot)
  const liveTree = await snapshotLiveTree(workTree, repoRoot)
  const changed = await changedPathsBetween(repoRoot, knownTree, liveTree)
  // Some file systems keep write times to the second.
  const since = Math.floor(turnStartedAt / 1000) * 1000
  const written: string[] = []
  await Promise.all(changed.map(async (path) => {
    const writtenAt = await lstat(join(workTree, path)).then((stat) => stat.mtimeMs, () => null)
    if (writtenAt !== null && writtenAt >= since) written.push(path)
  }))
  if (written.length === 0) return null
  const treeSha = written.length === changed.length ? knownTree : await restorePaths(repoRoot, liveTree, knownTree, written)
  return { baseSha, treeSha }
}
