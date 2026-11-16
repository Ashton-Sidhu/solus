import { placeReplyPullRequests, type ReplyPlacement } from '@solus/client-core/reply-pull-requests'
import { turnArtifacts } from '@solus/client-core/session-artifact-chips'
import { useMemo } from 'react'

import type { ConversationStore } from '../conversation/conversation-store'
import { useSessionArtifacts } from './artifacts/use-session-artifacts'
import type { TurnPromptIds } from './thread-feed-presentation'
import { useTranscriptItems } from './use-transcript-items'

/**
 * The pull request cards a settled turn's final reply shows, as desktop's
 * `turnReplyCards` places them (`placeReplyPullRequests`): a pull request the
 * turn linked takes a card where the reply mentions it. Null until the
 * session's links are read, and when the reply mentions none of them.
 */
export function useTurnReplyCards(store: ConversationStore, prompts: TurnPromptIds, replyId: string | null): ReplyPlacement | null {
  const { hostId, run } = store.controller
  const { snapshot } = useSessionArtifacts(hostId, run.sessionId, false)
  const ids = useMemo(
    () => [prompts.promptId, prompts.nextPromptId, replyId].filter((id) => id !== null),
    [prompts.promptId, prompts.nextPromptId, replyId],
  )
  const transcript = useTranscriptItems(store, ids)
  return useMemo(() => {
    if (snapshot.state.kind !== 'ready' || replyId === null) return null
    const timestampOf = (id: string | null) => {
      const item = transcript.find((entry) => entry.id === id)
      return item?.kind === 'user' ? (item.timestamp ?? null) : null
    }
    const startedAt = prompts.promptId === null ? 0 : timestampOf(prompts.promptId)
    const reply = transcript.find((entry) => entry.id === replyId)
    if (startedAt === null || reply?.kind !== 'assistant') return null
    const links = turnArtifacts(snapshot.state.artifacts.own, { startedAt, nextStartedAt: timestampOf(prompts.nextPromptId) }, () => [])
      .flatMap((item) => (item.kind === 'pull-request' ? [item.link] : []))
    if (links.length === 0) return null
    const placement = placeReplyPullRequests(reply.text, links)
    return placement.placed.size > 0 ? placement : null
  }, [snapshot, transcript, prompts.promptId, prompts.nextPromptId, replyId])
}
