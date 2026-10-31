import type { CanUseTool, OnUserDialog } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const question = 'Compact this session before you continue?'
const answerSchema = z.object({ answers: z.object({ [question]: z.enum(['Compact history', 'Keep full history', 'Never ask again']) }) })

/** Use the same question path as provider tool questions, including cancellation. */
export function resumeCompactionDialog(policy: 'onReturn' | 'off', canUseTool?: CanUseTool): OnUserDialog {
  return async (request, options) => {
    if (request.dialogKind !== 'resume_return') return { behavior: 'cancelled' }
    if (policy === 'off') return { behavior: 'completed', result: 'continue' }
    if (!canUseTool) return { behavior: 'cancelled' }
    const answer = await canUseTool('AskUserQuestion', {
      questions: [{ header: 'Resume session', question, options: [
        { label: 'Compact history', description: 'Continue with a summary and use fewer tokens.' },
        { label: 'Keep full history', description: 'Continue with the full conversation.' },
        { label: 'Never ask again', description: 'Keep full history and stop these prompts for this session.' },
      ], multiSelect: false }],
    }, { signal: options.signal, requestId: options.requestId, toolUseID: request.toolUseID ?? options.requestId })
    if (!answer || answer.behavior !== 'allow') return { behavior: 'cancelled' }
    const parsed = answerSchema.safeParse(answer.updatedInput)
    const selection = parsed.success ? parsed.data.answers[question] : undefined
    return { behavior: 'completed', result: selection === 'Compact history' ? 'compact' : selection === 'Never ask again' ? 'never' : 'continue' }
  }
}
