import { z } from 'zod'
import { questionReply } from '@solus/contracts/question-history'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { NormalizedEvent, QuestionAnswer } from '@solus/contracts/types'
import { getDb } from '../../db'

let recoveredAfterStart = false

function questionDb() {
  const db = getDb()
  if (!recoveredAfterStart) {
    // A host can stop after claiming a reply but before dispatching it.
    db.prepare("UPDATE async_questions SET state = 'pending' WHERE state = 'delivering'").run()
    recoveredAfterStart = true
  }
  return db
}

type AsyncQuestionEvent = Extract<NormalizedEvent, { type: 'question_request' }>

const asyncQuestionRowSchema = z.object({
  question_id: z.string(),
  agent_session_id: z.string(),
  questions_json: z.string(),
})

const questionsSchema = z.array(z.object({
  id: z.string().optional(),
  header: z.string().optional(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() })),
  multiSelect: z.boolean(),
}))

export function saveAsyncQuestion(sessionId: string, agentSessionId: string, event: AsyncQuestionEvent): boolean {
  return questionDb().prepare(`
    INSERT OR IGNORE INTO async_questions (question_id, session_id, agent_session_id, questions_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(event.questionId, sessionId, agentSessionId, JSON.stringify(event.questions), Date.now()).changes === 1
}

export function pendingAsyncQuestions(sessionId: string): AsyncQuestionEvent[] {
  const rows = asyncQuestionRowSchema.array().parse(questionDb().prepare(`
    SELECT question_id, session_id, agent_session_id, questions_json
    FROM async_questions WHERE session_id = ? AND state = 'pending' ORDER BY created_at
  `).all(sessionId))
  return rows.map((row) => ({
    type: 'question_request',
    questionId: row.question_id,
    responseMode: 'message',
    questions: questionsSchema.parse(JSON.parse(row.questions_json)),
  }))
}

export function claimAsyncQuestion(sessionId: string, questionId: string): { agentSessionId: string; questions: AsyncQuestionEvent['questions'] } | null {
  const db = questionDb()
  const claimed = db.prepare(`
    UPDATE async_questions SET state = 'delivering'
    WHERE question_id = ? AND session_id = ? AND state = 'pending'
  `).run(questionId, sessionId)
  if (claimed.changes !== 1) return null
  const row = asyncQuestionRowSchema.parse(db.prepare(`
    SELECT question_id, session_id, agent_session_id, questions_json
    FROM async_questions WHERE question_id = ?
  `).get(questionId))
  return { agentSessionId: row.agent_session_id, questions: questionsSchema.parse(JSON.parse(row.questions_json)) }
}

export function settleAsyncQuestion(questionId: string, state: 'pending' | 'answered' | 'dismissed'): void {
  questionDb().prepare("UPDATE async_questions SET state = ? WHERE question_id = ? AND state = 'delivering'").run(state, questionId)
}

/** Save the answer before delivery so a reload can reconstruct the receipt. */
export function saveAsyncAnswer(questionId: string, answers: QuestionAnswer['answers']): void {
  questionDb().prepare("UPDATE async_questions SET answers_json = ? WHERE question_id = ? AND state = 'delivering'")
    .run(JSON.stringify(answers), questionId)
}

/** Replace only confirmed async replies; ordinary user prompts stay intact. */
export function restoreAsyncQuestionAnswers(agentSessionId: string, messages: SessionLoadMessage[]): void {
  const rows = z.array(asyncQuestionRowSchema.extend({ answers_json: z.string().nullable() })).parse(
    questionDb().prepare(`SELECT question_id, agent_session_id, questions_json, answers_json
      FROM async_questions WHERE agent_session_id = ? AND state = 'answered' ORDER BY created_at`).all(agentSessionId),
  )
  for (const row of rows) {
    if (messages.some((message) => message.questionAnswer?.questionId === row.question_id)) continue
    const questions = questionsSchema.parse(JSON.parse(row.questions_json))
    const savedAnswers = row.answers_json === null ? undefined : z.record(z.string(), z.string()).parse(JSON.parse(row.answers_json))
    const questionIndex = messages.findIndex((message) => message.role === 'assistant'
      && message.messageId !== undefined && row.question_id === `codex-async:${agentSessionId}:${message.messageId}`)
    for (let index = questionIndex + 1; index < messages.length; index++) {
      const message = messages[index]
      if (message.role !== 'user' || message.parentToolUseId || message.questionAnswer) continue
      // Older hosts saved the question and delivery state, but not the answer.
      // Recover only the unambiguous single-question response they generated.
      const prefix = questions.length === 1 ? `${questions[0].question}\n` : undefined
      const answers = savedAnswers ?? (prefix && message.content.startsWith(prefix)
        ? { [questions[0].id ?? questions[0].question]: message.content.slice(prefix.length) }
        : undefined)
      if (!answers) continue
      const answer = { questionId: row.question_id, questions, answers }
      if (message.content !== questionReply(answer)) continue
      message.role = 'system'
      message.content = ''
      message.messageId = `question-answer-${row.question_id}`
      message.questionAnswer = answer
      break
    }
    // A separately loaded older page can contain only the original question.
    // Its accepted answer owns the Q&A row on the reply's page.
    if (questionIndex >= 0) {
      messages.splice(questionIndex, 1)
    }
  }
}
