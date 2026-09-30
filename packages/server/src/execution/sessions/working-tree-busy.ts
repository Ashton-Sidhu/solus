import { resolve } from 'node:path'
import { WORKING_TREE_BUSY_CODE } from '@solus/contracts/types'

/**
 * Another session runs a turn in the working tree a git action or a new session
 * wants (plan 004 item 7). It is not a lock: the transport sends the code, the
 * client asks the person, and a second request with `allowBusyWorkingTree`
 * continues.
 */
export class WorkingTreeBusyError extends Error {
  readonly code = WORKING_TREE_BUSY_CODE

  constructor(authorName: string | null) {
    super(authorName
      ? `${authorName} has a session running in this working tree.`
      : 'Another session is running in this working tree.')
    this.name = 'WorkingTreeBusyError'
  }
}

/** Who asks: the people in a session are not warned about that session. */
export interface WorkingTreeAsker {
  /** The session the request comes from; a new session has none that runs. */
  sessionId?: string
  /** The client that asks. A session this client watches is one its person is in. */
  clientId?: string
  /** The asker's user key (`userKey` of the actor's user). A turn they wrote is theirs. */
  userId: string | null
}

/** A running turn, as the busy check reads it. */
export interface RunningTurnInTree {
  sessionId: string
  tree: string
  authorUserId: string | null
  authorName: string | null
  watchedBy: ReadonlySet<string> | undefined
}

/**
 * The first running turn in `tree` that is busy for the asker, or null. The
 * asker's own session, a session their client watches, and a turn they wrote
 * are not busy for them.
 */
export function busyTurnFor(
  tree: string,
  asker: WorkingTreeAsker,
  running: Iterable<RunningTurnInTree>,
): RunningTurnInTree | null {
  if (!tree || tree === '~') return null
  const target = resolve(tree)
  for (const turn of running) {
    if (turn.sessionId === asker.sessionId) continue
    if (asker.clientId && turn.watchedBy?.has(asker.clientId)) continue
    if (asker.userId !== null && turn.authorUserId === asker.userId) continue
    if (turn.tree && turn.tree !== '~' && resolve(turn.tree) === target) return turn
  }
  return null
}
