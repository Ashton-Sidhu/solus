import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import { resolveRepoRoot } from './git-helpers'
import { turnActivity } from './turn-activity'
import { SESSION_CHANGE_SUMMARY_FILES, type DigestTurnChanges, type SessionChangeSummary } from '@solus/contracts/session-digest'
import type { TurnSnapshot } from '@solus/contracts/git-types'
import { getDiffStats, initSessionBase, prepareTurnSnapshot, sessionBaseCommit, snapshotTurn, type SnapshotOpts } from './session-snapshots'

const log = createLogger('TurnCheckpoints', 'turn-checkpoints.ts')

/**
 * The one owner of a turn's checkpoints. A backend tells it where a turn starts
 * and where it ends; how the checkout is captured is decided here. Both ends
 * are whole-checkout snapshots (`session-snapshots.ts`), so a turn's diff holds
 * every change, whichever tool or person made it, less what another session
 * wrote at the same time (`session-snapshots.ts`, with times from `turn-activity.ts`).
 */

/** Where one Solus session works. Snapshots belong to the session, not to one
 *  provider thread (docs/plans/session-identity.md). */
export interface CheckpointTarget {
  sessionId: string
  workTree: string
}

/** What one turn's checkpoint found: the session's change so far, and the turn's own totals. */
export interface TurnCheckpointed {
  sessionId: string
  changes: SessionChangeSummary
  turn: DigestTurnChanges & { endedAt: number }
}

const checkpointListeners = new Set<(checkpoint: TurnCheckpointed) => void>()

/** Hear each turn checkpoint, after its snapshot is written. */
export function onTurnCheckpointed(listener: (checkpoint: TurnCheckpointed) => void): () => void {
  checkpointListeners.add(listener)
  return () => checkpointListeners.delete(listener)
}

/** Capture the checkout before a provider turn starts. Never throws: a turn
 *  runs without a checkpoint rather than not at all. */
export async function beginTurnCheckpoint(target: CheckpointTarget): Promise<void> {
  try {
    const workTree = resolveHomePath(target.workTree)
    turnActivity.turnStarted(target.sessionId, workTree)
    const repoRoot = await resolveRepoRoot(workTree)
    if (!repoRoot) return
    await initSessionBase(repoRoot, target.sessionId, await sessionBaseCommit(workTree, repoRoot), workTree)
    await prepareTurnSnapshot(workTree, repoRoot, target.sessionId)
  } catch (error) {
    log.warn('turn_checkpoint_begin_failed', { sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Capture the checkout when a turn ends. Answers the paths the session has
 *  changed from its base, read from git, or null when no checkpoint was taken. */
export async function endTurnCheckpoint(target: CheckpointTarget, facts: SnapshotOpts): Promise<string[] | null> {
  try {
    const workTree = resolveHomePath(target.workTree)
    const repoRoot = await resolveRepoRoot(workTree)
    if (!repoRoot) return null
    const result = await snapshotTurn(workTree, repoRoot, target.sessionId, facts)
    // The summary is one more read of git; the turn does not wait for it.
    if (result && checkpointListeners.size > 0) void announceCheckpoint(workTree, repoRoot, target.sessionId, result.snapshot)
    return result?.sessionChangedFiles ?? null
  } catch (error) {
    log.warn('turn_checkpoint_end_failed', { sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    turnActivity.turnEnded(target.sessionId)
  }
}

async function announceCheckpoint(workTree: string, repoRoot: string, sessionId: string, snapshot: TurnSnapshot): Promise<void> {
  try {
    const checkpoint: TurnCheckpointed = {
      sessionId,
      changes: await changeSummary(workTree, repoRoot, sessionId),
      turn: { filesChanged: snapshot.filesChanged, additions: snapshot.additions, deletions: snapshot.deletions, endedAt: snapshot.timestamp },
    }
    for (const listener of checkpointListeners) listener(checkpoint)
  } catch (error) {
    log.warn('turn_checkpoint_summary_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** The session's own change from its base to the checkout now, the largest files first. */
async function changeSummary(workTree: string, repoRoot: string, sessionId: string): Promise<SessionChangeSummary> {
  const files = await getDiffStats(workTree, repoRoot, { kind: 'session' }, sessionId)
  files.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
  return {
    files: files.slice(0, SESSION_CHANGE_SUMMARY_FILES),
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}
