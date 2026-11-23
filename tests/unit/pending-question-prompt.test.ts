import { describe, expect, test } from 'bun:test'
import type { QuestionRequest, Session } from '@solus/contracts/types'
import {
  answersForQuestionNote,
  pendingQuestionForPrompt,
  promptHasMoreThanText,
} from '@solus/workspace-ui/components/input/lib/pending-question'
import { promptSendPath } from '@solus/workspace-ui/components/input/lib/pending-permission'
import { toQuestionRequest } from '@solus/workspace-ui/contexts/workspace/session.utils'

function request(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    questionId: 'question-1',
    questions: [{ id: 'strategy', question: 'Snapshot or hold?', options: [], multiSelect: false }],
    ...overrides,
  }
}

function session(status: Session['status'], questionQueue: QuestionRequest[]): Session {
  return { status, questionQueue } as Session
}

describe('pending question prompt routing', () => {
  test('routes the composer to the same live agent question shown by the card', () => {
    const pending = request()

    // WHY: a note typed in the normal composer must release AskUserQuestion /
    // request_user_input rather than queue behind the still-blocked turn.
    expect(pendingQuestionForPrompt(session('awaiting_input', [pending]))).toBe(pending)
  })

  test('keeps ordinary prompting when the question is historical or already resolved', () => {
    expect(pendingQuestionForPrompt(session('completed', [request()]))).toBeNull()
    expect(pendingQuestionForPrompt(session('awaiting_input', []))).toBeNull()
  })

  test('leaves MCP elicitations on their structured decision surface', () => {
    const mcpRequest = toQuestionRequest({
      type: 'question_request',
      questionId: 'mcp-1',
      questions: request().questions,
      kind: 'mcp_form',
    })

    // WHY: the normalized-event conversion must retain the discriminator or a
    // live MCP form looks like an ordinary Claude/Codex question in the composer.
    expect(pendingQuestionForPrompt(session('awaiting_input', [mcpRequest]))).toBeNull()
    expect(pendingQuestionForPrompt(session('awaiting_input', [request({ kind: 'mcp_url' })]))).toBeNull()
  })

  test('encodes the note as the first free-text answer and defers remaining questions', () => {
    const pending = request({
      questions: [
        { id: 'strategy', question: 'Snapshot or hold?', options: [], multiSelect: false },
        { question: 'How far?', options: [], multiSelect: false },
      ],
    })

    expect(answersForQuestionNote(pending, '  Snapshot, then release the lock.  ')).toEqual({
      strategy: 'Snapshot, then release the lock.',
      'How far?': '',
    })
  })

  test('a draft with only files still answers the open question', () => {
    // WHY: a screenshot sent with no words must not queue behind the turn that
    // waits on this question. Nothing would run that queue until someone
    // answered on the card.
    expect(promptSendPath({
      background: false,
      delivery: undefined,
      hasPendingPlan: false,
      hasPendingQuestion: true,
      hasFeedbackTarget: false,
      hasTargetTab: true,
    })).toBe('question-answer')
  })

  test('files and references go after the answer, because an answer is text only', () => {
    const empty = { text: 'Snapshot', attachments: [], planRefs: [], workRefs: [], sessionRefs: [] }
    expect(promptHasMoreThanText(empty)).toBe(false)
    expect(promptHasMoreThanText({ ...empty, attachments: [{ id: 'a', type: 'image', name: 'shot.png' }] } as never)).toBe(true)
    expect(promptHasMoreThanText({ ...empty, planRefs: [{ id: 'p' }] } as never)).toBe(true)
  })
})
