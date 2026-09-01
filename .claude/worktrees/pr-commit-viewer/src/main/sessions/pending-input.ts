import { questionKey } from '../../shared/question-answer'
import type { NormalizedEvent, PermissionOption } from '../../shared/types'

/**
 * The single structural read of a peer session's pause, built from its
 * `pendingInputEvents`. Provider-neutral: everything that differs between
 * Claude and Codex (option ids, whether a plan blocks a run) is resolved from
 * the event itself rather than hardcoded per provider.
 *
 * This is deliberately NOT `formatPendingInputReport` — that is prose for the
 * model's turn input. Tools answering a pause need ids and labels.
 */

export interface PendingQuestion {
  /** The key the answer record is filed under — see `shared/question-answer`. */
  key: string
  question: string
  header?: string
  /** Option labels, in the order they were offered. Empty = free text. */
  options: string[]
  multiSelect: boolean
}

export type PendingInputDescription =
  | { kind: 'question'; questionId: string; isMcpElicitation: boolean; questions: PendingQuestion[] }
  | {
      kind: 'plan'
      questionId: string
      planToolUseId?: string
      planContent: string
      /** True when the plan is a permission request holding a run open (Claude's
       *  `ExitPlanMode`), false when the turn already ended and the plan is only
       *  a report (Codex). A non-blocking plan has nothing to respond to and can
       *  only be driven by a follow-up prompt. */
      blocking: boolean
      allowOptionId?: string
      denyOptionId?: string
    }
  | { kind: 'permission'; toolName: string }

/** Latest pending item wins, matching `agentConversationQuestionFromPendingInput`
 *  — Codex re-emits a plan event per `turn/plan/updated`, so several may be
 *  queued and only the last one is current. */
export function describePendingInput(events: readonly NormalizedEvent[]): PendingInputDescription | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]

    if (event.type === 'question_request') {
      return {
        kind: 'question',
        questionId: event.questionId,
        isMcpElicitation: event.kind === 'mcp_form' || event.kind === 'mcp_url',
        questions: event.questions.map((q) => ({
          key: questionKey(q),
          question: q.question,
          ...(q.header ? { header: q.header } : {}),
          options: q.options.map((o) => o.label),
          multiSelect: q.multiSelect,
        })),
      }
    }

    if (event.type === 'permission_request') {
      return { kind: 'permission', toolName: event.toolName }
    }

    if (event.type === 'plan') {
      return {
        kind: 'plan',
        questionId: event.questionId,
        ...(event.planToolUseId ? { planToolUseId: event.planToolUseId } : {}),
        planContent: event.planContent,
        blocking: event.options.length > 0,
        ...pickOptionIds(event.options),
      }
    }
  }
  return null
}

/** `allow`/`deny` for Claude, `accept`/`decline` for Codex — read off the event
 *  so neither vocabulary is ever spelled out in a tool. */
function pickOptionIds(options: readonly PermissionOption[]): { allowOptionId?: string; denyOptionId?: string } {
  const allow = options.find((o) => o.kind === 'allow')
  const deny = options.find((o) => o.kind === 'deny')
  return {
    ...(allow ? { allowOptionId: allow.id } : {}),
    ...(deny ? { denyOptionId: deny.id } : {}),
  }
}
