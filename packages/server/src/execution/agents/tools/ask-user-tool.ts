import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentTool } from './agent-tool'

const fields = {
  questions: z.array(z.strictObject({
    title: z.string().trim().min(1).max(2000).describe('A self-contained question.'),
    options: z.array(z.string().trim().min(1).max(200)).min(1).max(6).optional()
      .describe('Suggested answers in order. Omit for free text only.'),
  })).min(1).max(3),
}

export const askUserAgentTool: AgentTool<typeof fields> = {
  name: 'ask_user',
  description: 'Ask the user for information or a choice in a question card. The call returns immediately. Answers arrive as user messages, even after the turn ends. If you need the answer to proceed, end the turn and wait. Use request_secret for passwords or tokens.',
  inputFields: fields,
  requiresApproval: false,
  alwaysLoad: true,
  strictInput: true,
  async execute({ questions }, context) {
    const sessionId = context.sessionId()
    if (!sessionId || context.abortSignal.aborted) {
      return { ok: false, text: 'This tool requires an active Solus session.' }
    }
    const questionId = `solus-ask:${sessionId}:${context.parentToolUseId() ?? randomUUID()}`
    context.emit({
      type: 'question_request',
      questionId,
      responseMode: 'message',
      questions: questions.map(({ title, options }, index) => ({
        id: String(index),
        header: 'Question',
        question: title,
        options: [...new Set(options)].map((label) => ({ label })),
        multiSelect: false,
      })),
    })
    return { ok: true, text: 'Question submitted. Any answer arrives as a user message.' }
  },
}
