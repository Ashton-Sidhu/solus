import type { Plan, Session } from '../../../../shared/types'

/**
 * The normal composer becomes plan feedback only while this exact session is
 * blocked on a live plan approval. Historical pending plans and Codex's
 * non-blocking plan updates must keep ordinary prompt behavior.
 */
export function pendingPlanForPrompt(
  session: Session | undefined,
  plans: Record<string, Plan>,
): Plan | null {
  if (session?.status !== 'awaiting_plan') return null

  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]
    if (message.role !== 'plan' || !message.planId) continue
    const plan = plans[message.planId]
    if (plan?.status === 'pending' && plan.questionId && plan.options?.length) {
      return plan
    }
  }

  return null
}
