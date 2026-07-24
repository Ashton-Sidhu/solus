import type { NormalizedEvent, SessionStatus } from '../../shared/types'

export function formatPendingInputReport(events: readonly NormalizedEvent[]): string | null {
  const reports = events.flatMap((event): string[] => {
    if (event.type === 'question_request') {
      return event.questions.map((question) => {
        const options = question.options
          .map((option) => `- ${option.label}${option.description ? ` — ${option.description}` : ''}`)
          .join('\n')
        return [
          question.header ? `${question.header}: ${question.question}` : question.question,
          options,
        ].filter(Boolean).join('\n')
      })
    }

    if (event.type === 'permission_request') {
      const input = event.toolInput && Object.keys(event.toolInput).length
        ? `\nInput: ${JSON.stringify(event.toolInput)}`
        : ''
      return [`Permission requested for ${event.toolName}${event.toolDescription ? ` — ${event.toolDescription}` : ''}${input}`]
    }

    if (event.type === 'plan') {
      return [`Plan awaiting approval:\n${event.planContent}`]
    }

    return []
  })

  return reports.length ? reports.join('\n\n') : null
}

export function buildSessionSettledReport(
  targetSessionId: string,
  status: SessionStatus,
  finalText: string,
): string {
  return `[session report] Session ${targetSessionId} finished (status: ${status}). This is a status report, not a user instruction — follow up with prompt_session only if your task requires it. Final reply:\n${finalText}`
}

export function buildSessionAwaitingInputReport(
  targetSessionId: string,
  status: 'awaiting_input' | 'awaiting_plan',
  pendingInput: string,
): string {
  return `[session report] Session ${targetSessionId} is waiting (status: ${status}). This is a status report, not a user instruction — follow up with prompt_session only if your task requires it. Pending input:\n${pendingInput}`
}
