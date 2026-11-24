import type { AddMachineAsk } from '@solus/contracts/add-machine'
import type { PermissionOption, QuestionItem, QuestionRequest, RequestExpiry } from '@solus/contracts/types'

/** The requests a conversation holds open for the person, as the native client shows them. */

export interface PendingPermission {
  questionId: string
  toolName: string
  description: string | null
  options: PermissionOption[]
  /** A link guest sent the turn, so it runs in Ask mode whatever the session's mode is. */
  guestTurn?: true
  /** A denial can carry the user's text to the agent that asked (Claude only). */
  supportsFeedback?: true
  /** Set when the request can no longer be answered. */
  expired?: RequestExpiry
}

/**
 * The permission the composer's text denies, as feedback to the agent that
 * asked: the one the card shows, while it is open and its provider takes a
 * denial message (Claude). Any other request leaves the composer ordinary.
 */
export function permissionForFeedback(permissions: readonly PendingPermission[]): { questionId: string; denyOptionId: string } | null {
  const request = permissions[0]
  if (!request || request.expired || !request.supportsFeedback) return null
  const deny = request.options.find((option) => option.kind === 'deny')
  return deny ? { questionId: request.questionId, denyOptionId: deny.id } : null
}

export interface PendingQuestion {
  questionId: string
  questions: QuestionItem[]
  responseMode?: 'message'
  /** `secret`: a `request_secret` card, answered with `secretRequestAnswer`, never `respondQuestion`.
   *  `host-link`: the Add machine card of `add_host` (docs/plans/add-machine-card.md). */
  kind?: QuestionRequest['kind']
  /** `host-link` only: what the agent asks to add. */
  hostLink?: AddMachineAsk
  /** Set when the question can no longer be answered. */
  expired?: RequestExpiry
}

/**
 * A question with its own card above the composer, not T3's pending input card:
 * the secret card and the Add machine card. Their values never go to the composer,
 * so the composer is hidden while one is open.
 */
export function hasOwnCard(question: Pick<PendingQuestion, 'kind'> | undefined): boolean {
  return question?.kind === 'secret' || question?.kind === 'host-link'
}

export interface QueuedPrompt {
  queueId: string
  text: string
  clientPromptId?: string
}
