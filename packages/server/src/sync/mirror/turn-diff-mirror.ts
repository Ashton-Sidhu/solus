import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnSnapshot } from '@solus/contracts/git-types'
import { writeTurnDiffPatch } from '../../git/session-code-bundle'
import { createLogger } from '../../logger'
import { appendDelivery, kindSupported } from '../delivery-queue'
import { TURN_DIFF_PATCH_BYTES, type TurnDiffMirrorPayload } from '../runner-protocol'
import { mirrorDestination } from './transcript-mirror'

const log = createLogger('main', 'turn-diff-mirror')

/** One ended turn of a session, as its turn commit records it. */
export interface EndedTurn {
  sessionId: string
  /** The turn's index in the session repository of this host. */
  turnIndex: number
  endedAt: number
  /** The checkout whose snapshot trees the turn changed. */
  repoRoot: string
  /** The snapshots of the session that the turn commit covers. */
  snapshots: ReadonlyArray<Pick<TurnSnapshot, 'fromTreeSha' | 'toTreeSha' | 'filesChanged' | 'additions' | 'deletions'>>
}

/**
 * The turn diff producer of the mirror (docs/plans/portable-sessions-cloud.md,
 * "The mirror for readers"). The mirror holds the code changes of each ended
 * turn for a reader with no host online; the session repository holds none.
 * A turn goes where its session's rows go (`mirrorDestination`), so the same
 * publication and the same cloud sync switch gate it. A patch over
 * `TURN_DIFF_PATCH_BYTES` sends its counts only. The item's key is the turn,
 * and the sink writes by key, so a turn that is given again changes nothing.
 */
export async function mirrorTurnDiff(turn: EndedTurn): Promise<void> {
  const first = turn.snapshots[0]
  const last = turn.snapshots.at(-1)
  if (!first || !last || first.fromTreeSha === last.toTreeSha) return
  const destination = await mirrorDestination(turn.sessionId)
  if (!destination || !kindSupported(destination.organizationId, 'turn-diff')) return
  const scratch = await mkdtemp(join(tmpdir(), 'solus-turn-diff-'))
  try {
    const patchFile = join(scratch, 'turn.patch')
    await writeTurnDiffPatch(turn.repoRoot, first.fromTreeSha, last.toTreeSha, patchFile)
    const { size } = await stat(patchFile)
    const sum = (count: (snapshot: EndedTurn['snapshots'][number]) => number): number => turn.snapshots.reduce((total, snapshot) => total + count(snapshot), 0)
    const payload: TurnDiffMirrorPayload = {
      sessionId: turn.sessionId, turnIndex: turn.turnIndex, endedAt: turn.endedAt,
      filesChanged: sum((snapshot) => snapshot.filesChanged), additions: sum((snapshot) => snapshot.additions), deletions: sum((snapshot) => snapshot.deletions),
      patch: size > TURN_DIFF_PATCH_BYTES ? null : await readFile(patchFile, 'utf8'),
    }
    appendDelivery(destination, 'turn-diff', [{ key: `${turn.sessionId}:${turn.turnIndex}`, payload }])
    log.info('turn_diff_mirrored', { sessionId: turn.sessionId, organizationId: destination.organizationId, turnIndex: turn.turnIndex, bytes: size, tooLarge: payload.patch === null })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
