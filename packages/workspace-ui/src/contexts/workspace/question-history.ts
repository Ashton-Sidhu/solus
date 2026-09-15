import type { Message, QuestionAnswer } from '@solus/contracts/types'
import { isQuestionTool, parseQuestionInput } from '@solus/contracts/question-history'

/** Merge an accepted answer into its tool row when available. Codex can ask
 * without a tool row, so otherwise append an in-memory conversation receipt. */
export function recordQuestionAnswer(messages: Message[], answer: QuestionAnswer, timestamp: number): void {
  if (messages.some((message) => message.questionAnswer?.questionId === answer.questionId)) return
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') break
    if (!isQuestionTool(message.toolName) || message.questionAnswer) continue
    const input = parseQuestionInput(message.toolInput)
    const matches = input?.questions.length === answer.questions.length && input.questions.every(
      (question, index) => question.question === answer.questions[index].question && question.id === answer.questions[index].id,
    )
    if (message.toolId === answer.questionId || matches) {
      message.questionAnswer = answer
      return
    }
  }
  messages.push({
    id: `question-answer-${answer.questionId}`, role: 'system', content: '', timestamp, questionAnswer: answer,
  })
}
