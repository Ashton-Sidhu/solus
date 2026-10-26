import type { Prompt, Session } from '@solus/contracts/types'

export interface PermissionFeedbackTarget {
  questionId: string
  denyOptionId: string
}

/**
 * The permission the composer's text denies, as feedback to the agent that
 * asked: the one the card shows, while it is open and its provider takes a
 * denial message (Claude). Any other request leaves the composer ordinary.
 */
export function permissionForFeedback(session: Session | undefined): PermissionFeedbackTarget | null {
  const request = session?.permissionQueue[0]
  if (!request || request.expired || !request.supportsFeedback) return null
  const deny = request.options.find((option) => option.kind === 'deny')
  return deny ? { questionId: request.questionId, denyOptionId: deny.optionId } : null
}

/** Whether the draft holds only text: a denial's feedback carries no attachment or reference. */
export function isTextOnly(prompt: Prompt): boolean {
  return prompt.attachments.length === 0 && prompt.planRefs.length === 0 && prompt.workRefs.length === 0 && prompt.sessionRefs.length === 0
}
