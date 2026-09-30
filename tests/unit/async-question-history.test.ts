import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { questionReply } from '@solus/contracts/question-history'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const previousDataDir = process.env.SOLUS_DATA_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'solus-question-history-'))
let db: typeof import('@solus/server/db')
let store: typeof import('@solus/server/data/sessions/async-questions')
beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  store = await import('@solus/server/data/sessions/async-questions')
})
afterAll(() => {
  db.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const questions = [{ id: '0', question: 'Which branch?', options: [{ label: 'main' }], multiSelect: false }]
function save(sessionId: string, legacy = false) {
  const questionId = `codex-async:${sessionId}:ask`
  store.saveAsyncQuestion(sessionId, sessionId, { type: 'question_request', questionId, questions, responseMode: 'message' })
  expect(store.claimAsyncQuestion(sessionId, questionId)).not.toBeNull()
  const answer = { questionId, questions, answers: { '0': 'main' } }
  if (!legacy) store.saveAsyncAnswer(questionId, answer.answers)
  return answer
}

for (const legacy of [false, true]) {
  test(`reload restores one Q&A without changing an earlier identical prompt (legacy=${legacy})`, () => {
    const sessionId = `reload-${legacy}`
    const answer = save(sessionId, legacy)
    store.settleAsyncQuestion(answer.questionId, 'answered')
    db.closeDb()
    const reply = questionReply(answer)
    const messages: SessionLoadMessage[] = [
      { role: 'user', content: reply, timestamp: 1 },
      { role: 'assistant', messageId: 'ask', content: 'Which branch?\n- main', timestamp: 2 },
      { role: 'user', content: reply, timestamp: 3 },
      { role: 'assistant', content: 'Done', timestamp: 4 },
    ]
    store.restoreAsyncQuestionAnswers(sessionId, messages)
    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatchObject({ role: 'user', content: reply })
    expect(messages[1]).toMatchObject({ role: 'system', content: '', questionAnswer: answer })
    store.restoreAsyncQuestionAnswers(sessionId, messages)
    expect(messages.filter((message) => message.questionAnswer)).toHaveLength(1)
  })
}

test('a reply page restores the answer even when the question is on an older page', () => {
  const answer = save('paged')
  store.settleAsyncQuestion(answer.questionId, 'answered')
  const messages: SessionLoadMessage[] = [{ role: 'user', content: questionReply(answer), timestamp: 5 }]
  store.restoreAsyncQuestionAnswers('paged', messages)
  expect(messages[0].questionAnswer).toEqual(answer)
})

test('failed delivery remains pending and cannot turn a user message into a receipt', () => {
  const answer = save('failed')
  store.settleAsyncQuestion(answer.questionId, 'pending')
  const messages: SessionLoadMessage[] = [{ role: 'user', content: questionReply(answer), timestamp: 1 }]
  store.restoreAsyncQuestionAnswers('failed', messages)
  expect(messages[0].questionAnswer).toBeUndefined()
  expect(store.pendingAsyncQuestions('failed')).toHaveLength(1)
})

test('multiple answers and free text survive reload exactly', () => {
  const sessionId = 'multiple'
  const questionId = `codex-async:${sessionId}:ask`
  const many = [...questions, { id: '1', question: 'Why?', options: [], multiSelect: false }]
  const answer = { questionId, questions: many, answers: { '0': 'main', '1': 'First line\nSecond line' } }
  store.saveAsyncQuestion(sessionId, sessionId, { type: 'question_request', questionId, questions: many })
  store.claimAsyncQuestion(sessionId, questionId)
  store.saveAsyncAnswer(questionId, answer.answers)
  store.settleAsyncQuestion(questionId, 'answered')
  const messages: SessionLoadMessage[] = [{ role: 'user', content: questionReply(answer), timestamp: 1 }]
  store.restoreAsyncQuestionAnswers(sessionId, messages)
  expect(messages[0].questionAnswer).toEqual(answer)
})

test('an older question-only page does not repeat an already answered question', () => {
  const answer = save('older-page')
  store.settleAsyncQuestion(answer.questionId, 'answered')
  const messages: SessionLoadMessage[] = [{ role: 'assistant', messageId: 'ask', content: 'Which branch?', timestamp: 1 }]
  store.restoreAsyncQuestionAnswers('older-page', messages)
  expect(messages).toEqual([])
})

test('several open questions can be answered in reverse order', () => {
  const sessionId = 'reverse'
  const answers = ['First?', 'Second?'].map((question, index) => {
    const questionId = `codex-async:${sessionId}:ask-${index}`
    const items = [{ id: '0', question, options: [], multiSelect: false }]
    const answer = { questionId, questions: items, answers: { '0': 'yes' } }
    store.saveAsyncQuestion(sessionId, sessionId, { type: 'question_request', questionId, questions: items })
    store.claimAsyncQuestion(sessionId, questionId)
    store.saveAsyncAnswer(questionId, answer.answers)
    store.settleAsyncQuestion(questionId, 'answered')
    return answer
  })
  const messages: SessionLoadMessage[] = answers.toReversed().map((answer) => ({ role: 'user', content: questionReply(answer), timestamp: 1 }))
  store.restoreAsyncQuestionAnswers(sessionId, messages)
  expect(messages.map((message) => message.questionAnswer)).toEqual(answers.toReversed())
})
