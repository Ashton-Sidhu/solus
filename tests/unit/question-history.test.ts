import { describe, expect, test } from 'bun:test'
import type { Message, QuestionAnswer } from '@solus/contracts/types'
import { isQuestionTool, parseQuestionInput } from '@solus/contracts/question-history'
import { recordQuestionAnswer } from '@solus/workspace-ui/contexts/workspace/question-history'
import { buildTurns, groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { activityKinds } from '@solus/workspace-ui/components/conversation/lib/activity-summary'
import { projectSessionHistory, projectSessionEvent } from '@solus/server/server/result-projection'
import { deferSessionToolInputs } from '@solus/server/server/session-tool-inputs'

const answer: QuestionAnswer = {
  questionId: 'q1', questions: [{ id: 'scope', question: 'Which branch?', options: [{ label: 'main' }], multiSelect: false }],
  answers: { scope: 'main — Keep the release branch unchanged.' },
}
const tool = (id: string, toolName: string): Message => ({
  id, toolId: id, role: 'tool', toolName, content: '', timestamp: 2, toolStatus: 'completed',
  toolInput: JSON.stringify({ questions: answer.questions }),
})
const user: Message = { id: 'user', role: 'user', content: 'Make the change', timestamp: 1 }
const final: Message = { id: 'final', role: 'assistant', content: 'Done.', timestamp: 5 }

describe('answered question history', () => {
  for (const providerTool of ['AskUserQuestion', 'functions.request_user_input']) {
    test(`${providerTool} folds with the turn it was asked in, without a duplicate tool row`, () => {
      const question = tool('q1', providerTool)
      const messages = [user, tool('before', 'Read'), question, tool('after', 'Bash'), final]
      recordQuestionAnswer(messages, answer, 4)
      recordQuestionAnswer(messages, answer, 4)
      expect(messages).toHaveLength(5)
      expect(messages[2]).toBe(question)
      for (const running of [true, false]) {
        const [turn] = buildTurns(groupMessages(messages), { running })
        // WHY: an answered question is history like every other step of the
        // turn, so it folds with them — but the decision must not vanish with
        // the fold, so the summary row still reports that the turn asked.
        expect(turn.body.map((item) => item.kind)).toContain('question')
        expect(turn.visibleWhenCollapsed).toHaveLength(0)
        expect(activityKinds(turn.tools)).toContain('ask')
        expect(turn.body.filter((item) => item.kind === 'tool-group').flatMap((item) => item.messages.map((m) => m.id))).toEqual(['before', 'after'])
      }
      expect(question.questionAnswer?.answers.scope).toContain('release branch')
    })
  }

  test('Codex without a tool row retains an in-memory answer and deduplicates replay', () => {
    const messages = [user]
    recordQuestionAnswer(messages, answer, 4)
    recordQuestionAnswer(messages, answer, 4)
    expect(messages).toHaveLength(2)
    expect(messages[1].questionAnswer).toEqual(answer)
    // WHY: the receipt has no tool name to classify, so the summary row would
    // report a decision the reader made as "used tools" — or not at all.
    expect(activityKinds(buildTurns(groupMessages(messages), { running: false })[0].tools)).toEqual(['ask'])
    expect(projectSessionEvent({ type: 'question_answered', answer, timestamp: 4 })).toEqual({ type: 'question_answered', answer, timestamp: 4 })
  })

  test('does not attach a repeated question to an earlier turn', () => {
    const messages = [tool('old', 'AskUserQuestion'), user]
    recordQuestionAnswer(messages, answer, 4)
    expect(messages[0].questionAnswer).toBeUndefined()
    expect(messages[2].questionAnswer).toEqual(answer)
  })

  test('reload preserves only the question and answer actually in provider history', () => {
    const history = projectSessionHistory([
      { role: 'tool', toolId: 'q1', toolName: 'AskUserQuestion', content: '', toolInput: JSON.stringify({ questions: answer.questions }), timestamp: 1 },
      { role: 'tool_result', toolResultForId: 'q1', content: 'User answered: main', timestamp: 2 },
      { role: 'tool', toolId: 'read', toolName: 'Read', toolInput: '{"path":"secret"}', content: 'ordinary output', timestamp: 3 },
    ])
    const deferred = deferSessionToolInputs(history)
    expect(deferred[0].toolInput).toBeDefined()
    expect(deferred[1].questionResult).toBe('User answered: main')
    expect(deferred[2].content).toBe('')
    expect(deferred[2].questionResult).toBeUndefined()
    expect(deferred[2].toolInput).toBeUndefined()
    expect(parseQuestionInput(deferred[0].toolInput)?.answers).toBeUndefined()
  })

  test('malformed or unrelated inputs are not interpreted as answers', () => {
    expect(isQuestionTool('not_request_user_input_helper')).toBe(false)
    expect(isQuestionTool('mcp__solus__request_user_input')).toBe(true)
    expect(parseQuestionInput('{broken')).toBeUndefined()
    expect(parseQuestionInput('{"questions":[1]}')).toBeUndefined()
    expect(parseQuestionInput('{"questions":[{"question":"Why?"}],"answers":{"Why?":"Because"}}')?.answers).toEqual({ 'Why?': 'Because' })
  })
})
