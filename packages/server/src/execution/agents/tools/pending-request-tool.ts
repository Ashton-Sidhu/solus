import { z } from 'zod'
import { questionKey } from '@solus/contracts/question-answer'
import type { QuestionItem } from '@solus/contracts/types'
import { isAgentAnswerableQuestion } from '../../sessions/input-requests'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { getSessionController } from './session-tools'

const fields = {
  action: z.enum(['list', 'read', 'respond']),
  session_id: z.string().trim().min(1).describe('The session on this host that asked.'),
  request_id: z.string().min(1).optional().describe('The ID from list. Required for read and respond.'),
  answers: z.record(z.string(), z.string().trim().min(1)).optional()
    .describe('Use IDs and labels from read. Answer required fields. Join choices with commas.'),
}

type PendingQuestion = QuestionItem & { id: string; required?: boolean }

type PendingRequestResult = { request_ids: string[] }
  | { request_id: string; questions: PendingQuestion[] }
  | { request_id: string; answered: true }

function result(value: PendingRequestResult): AgentToolResult {
  return { ok: true, text: JSON.stringify(value), format: 'json' }
}

function invalidFormChoice(questions: PendingQuestion[], answers: Record<string, string>): string | undefined {
  for (const question of questions) {
    if (!Object.hasOwn(answers, question.id) || question.options.length === 0) continue
    const answer = answers[question.id]!
    const choices = question.multiSelect ? answer.split(',').map((choice) => choice.trim()) : [answer]
    if (!choices.every((choice) => question.options.some((option) => option.label === choice))) return question.id
  }
}

export const pendingRequestAgentTool: AgentTool<typeof fields> = {
  name: 'pending_request',
  description: 'List, read, or answer pending questions in a Solus session on this host. List returns request IDs. Read returns questions and answer keys. Respond only when the user delegated the decision or supplied the answers. If a required decision is still unclear, ask the user.',
  inputFields: fields,
  requiresApproval: false,
  strictInput: true,
  async execute({ action, session_id, request_id, answers }, context) {
    const callerSessionId = context.sessionId()
    const controller = getSessionController()
    if (!callerSessionId || !controller || context.abortSignal.aborted) {
      return { ok: false, text: 'This tool requires an active Solus session.' }
    }
    const pending = controller.pendingInputEvents(session_id).filter(isAgentAnswerableQuestion)
    if (action === 'list') return result({ request_ids: pending.map((request) => request.questionId) })
    if (!request_id) return { ok: false, text: 'Read and respond require a request_id from list.' }
    const request = pending.find((event) => event.questionId === request_id)
    if (!request) return { ok: false, text: 'That question is no longer pending in this session.' }
    const form = request.agentAnswerableForm
    const questions = request.questions.map((question) => {
      const id = questionKey(question)
      return form ? { ...question, id, required: form.requiredFields.includes(id) } : { ...question, id }
    })
    if (action === 'read') return result({ request_id, questions })
    const questionIds = new Set(questions.map((question) => question.id))
    const requiredIds = form?.requiredFields ?? [...questionIds]
    if (!answers || Object.keys(answers).length === 0 || !requiredIds.every((id) => Object.hasOwn(answers, id)) ||
      !Object.keys(answers).every((id) => questionIds.has(id))) {
      return { ok: false, text: 'Use the IDs from read and answer every required field.' }
    }
    const invalidChoice = form && invalidFormChoice(questions, answers)
    if (invalidChoice) return { ok: false, text: `Use the offered choices for "${invalidChoice}".` }
    const accepted = await controller.answerPendingQuestion?.(session_id, request_id, answers, {
      sessionId: callerSessionId, provider: context.provider,
    })
    return accepted ? result({ request_id, answered: true })
      : { ok: false, text: 'The host could not accept this answer. The question may have closed or your access may have changed.' }
  },
}
