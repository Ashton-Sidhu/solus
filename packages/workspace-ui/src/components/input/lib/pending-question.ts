import { formatAnswer, questionKey } from '@solus/contracts/question-answer'
import type { QuestionRequest, Session } from '@solus/contracts/types'

export interface QuestionNoteAnswers {
  [questionKey: string]: string
}

/**
 * The normal composer becomes a free-text answer only while this session is
 * blocked on an agent question. MCP elicitations keep their structured card:
 * accepting one can have side effects beyond supplying an answer.
 */
export function pendingQuestionForPrompt(
  session: Session | undefined,
): QuestionRequest | null {
  if (session?.status !== 'awaiting_input') return null

  const request = session.questionQueue[0]
  if (!request || (request.kind && request.kind !== 'standard')) return null
  return request.questions.length > 0 ? request : null
}

/** Encode composer text exactly like a free-text remark in the question card. */
export function answersForQuestionNote(
  request: QuestionRequest,
  note: string,
): QuestionNoteAnswers {
  const answers: QuestionNoteAnswers = {}
  request.questions.forEach((question, index) => {
    answers[questionKey(question)] = index === 0 ? formatAnswer('', note) : ''
  })
  return answers
}
