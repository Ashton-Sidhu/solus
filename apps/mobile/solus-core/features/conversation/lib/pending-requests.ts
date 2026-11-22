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
  /** `secret`: a `request_secret` card, answered with `secretRequestAnswer`, never `respondQuestion`. */
  kind?: QuestionRequest['kind']
  /** Set when the question can no longer be answered. */
  expired?: RequestExpiry
}

export interface QueuedPrompt {
  queueId: string
  text: string
  clientPromptId?: string
}
