import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import { resolveRepoRoot } from './git-helpers'
import { getHeadCommit } from './worktree-manager'
import { initSessionBase, prepareTurnSnapshot, snapshotTurn, type SnapshotOpts } from './session-snapshots'

const log = createLogger('TurnCheckpoints', 'turn-checkpoints.ts')

/**
 * The one owner of a turn's checkpoints. A backend tells it where a turn starts
 * and where it ends; how the checkout is captured is decided here. Both ends
 * are whole-checkout snapshots (`session-snapshots.ts`), so a turn's diff holds
 * every change, whichever tool or person made it.
 */

/** Where one Solus session works. Snapshots belong to the session, not to one
 *  provider thread (docs/plans/session-identity.md). */
export interface CheckpointTarget {
  sessionId: string
  workTree: string
}

/** Capture the checkout before a provider turn starts. Never throws: a turn
 *  runs without a checkpoint rather than not at all. */
export async function beginTurnCheckpoint(target: CheckpointTarget): Promise<void> {
  try {
    const workTree = resolveHomePath(target.workTree)
    const repoRoot = await resolveRepoRoot(workTree)
    if (!repoRoot) return
    const head = await getHeadCommit(workTree)
    if (!head) return
    await initSessionBase(repoRoot, target.sessionId, head)
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
    return result?.sessionChangedFiles ?? null
  } catch (error) {
    log.warn('turn_checkpoint_end_failed', { sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
