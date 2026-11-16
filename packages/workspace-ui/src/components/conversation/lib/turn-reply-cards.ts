import { placeReplyPullRequests, type ReplySegment } from '@solus/client-core/reply-pull-requests'
import { turnArtifacts } from '@solus/client-core/session-artifact-chips'
import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import type { Turn } from './turns'

/** The cards a finished turn's final reply shows: which message, its parts,
 *  and the pull requests that took a card there and so take no chip. */
export interface TurnReplyCards {
  replyId: string
  segments: ReplySegment[]
  placed: ReadonlySet<string>
}

/**
 * The pull request cards in a finished turn's final reply, its last
 * assistant message (`placeReplyPullRequests`). Null while the turn runs, or
 * when the reply mentions none of the pull requests the turn linked.
 */
export function turnReplyCards(turn: Turn, sessionArtifacts: readonly SessionArtifact[], nextStartedAt: number | null): TurnReplyCards | null {
  if (turn.live) return null
  const reply = turn.tail.findLast((item) => item.kind === 'assistant')
  if (reply?.kind !== 'assistant') return null
  const links = turnArtifacts(sessionArtifacts, { startedAt: turn.startedAt, nextStartedAt }, () => [])
    .flatMap((item) => (item.kind === 'pull-request' ? [item.link] : []))
  if (links.length === 0) return null
  const { segments, placed } = placeReplyPullRequests(reply.message.content, links)
  return placed.size > 0 ? { replyId: reply.message.id, segments, placed } : null
}
