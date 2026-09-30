import { questionKey } from '@solus/contracts/question-answer'
import {
  ORCHESTRATION_LIMITS,
  sessionOutputKey,
  type ExchangeRequest,
  type SessionOutput,
} from '@solus/contracts/session-exchange'
import type { NormalizedEvent } from '@solus/contracts/types'
import { extractPlanTitle } from '../agents/plan-text'

/**
 * What a child's turn produced, as references the parent can act on: the
 * questions a person answered, the plans and works it wrote, the files it
 * changed, the pull request for its branch and the sessions it started. The
 * orchestrator keeps one list per exchange and publishes it when the turn ends.
 */

/** A person's answer to what a turn was waiting on, as the responder saw it. */
export type ResolvedInput =
  | { kind: 'question'; questions: ReadonlyArray<{ id?: string; question: string }>; answers: Record<string, string> }
  | { kind: 'permission'; toolName?: string; allowed: boolean }
  | { kind: 'plan'; allowed: boolean; edited: boolean }

/** Adds `output` once. A later list of changed files replaces the earlier one:
 *  the session reports its running total. */
export function addOutput(outputs: SessionOutput[], output: SessionOutput): void {
  const key = sessionOutputKey(output)
  const at = outputs.findIndex((existing) => sessionOutputKey(existing) === key)
  if (at === -1) outputs.push(output)
  else if (output.kind === 'changed_files') outputs[at] = output
}

/** The output a turn event names, if it names one. */
export function outputFromEvent(event: NormalizedEvent, agentSessionId: string | null | undefined): SessionOutput | null {
  if (event.type === 'plan' && event.planToolUseId && agentSessionId) {
    return { kind: 'plan', sessionId: agentSessionId, planToolUseId: event.planToolUseId, title: extractPlanTitle(event.planContent) }
  }
  if (event.type === 'work_created') return { kind: 'work', workId: event.workId, title: event.title, workType: event.docType }
  if (event.type === 'artifact_created' && event.workId) {
    return { kind: 'work', workId: event.workId, title: event.title ?? 'Artifact', workType: 'artifact' }
  }
  // A session reports its changed files even when there are none; that is not an output.
  if (event.type === 'session_changed_files_updated' && agentSessionId && event.paths.length) {
    return { kind: 'changed_files', sessionId: agentSessionId, count: event.paths.length, paths: event.paths.slice(0, ORCHESTRATION_LIMITS.cardChangedPaths) }
  }
  return null
}

/** The outputs a person's answer adds. A plan decision adds none: the plan is
 *  already an output, and its decision is recorded on the plan. */
export function outputsFromAnswer(resolved: ResolvedInput): SessionOutput[] {
  if (resolved.kind === 'question') {
    return resolved.questions.map((question) => {
      const answer = resolved.answers[questionKey(question)]
      return answer ? { kind: 'question', question: question.question, answer } : { kind: 'question', question: question.question }
    })
  }
  if (resolved.kind === 'permission') return [{ kind: 'permission', tool: resolved.toolName ?? 'a tool', allowed: resolved.allowed }]
  return []
}

/** Questions the turn asked and ended without an answer to. */
export function unansweredOutputs(request: ExchangeRequest | undefined): SessionOutput[] {
  if (request?.kind !== 'question') return []
  return request.question.questions.map((question) => ({ kind: 'question', question: question.question }))
}

/** One line a card shows for what a person answered. */
export function answerText(resolved: ResolvedInput): string {
  if (resolved.kind === 'question') {
    return resolved.questions
      .map((question) => {
        const answer = resolved.answers[questionKey(question)]
        return answer ? `${question.question} → ${answer}` : null
      })
      .filter(Boolean)
      .join('\n') || '(handed the decision back)'
  }
  if (resolved.kind === 'plan') {
    if (!resolved.allowed) return 'Rejected the plan'
    return resolved.edited ? 'Approved the plan, with edits' : 'Approved the plan'
  }
  return `${resolved.allowed ? 'Allowed' : 'Denied'} ${resolved.toolName ?? 'the request'}`
}
