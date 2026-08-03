import { describe, expect, test } from 'bun:test'
import type { QuestionRequest, Session } from '../../src/shared/types'
import {
  answersForQuestionNote,
  pendingQuestionForPrompt,
} from '../../src/renderer/components/input/lib/pending-question'
import { toQuestionRequest } from '../../src/renderer/contexts/workspace/session.utils'

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
})
