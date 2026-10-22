import { describe, expect, test } from 'bun:test'
import type { NormalizedEvent, QuestionRequest, Session } from '@solus/contracts/types'
import { draftWithUnsentRemarks } from '@solus/contracts/question-answer'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'
import { syncPendingInputFromEvent } from '@solus/workspace-ui/contexts/workspace/session-transcript'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'

// A user can type their own answer in a question card and then press Stop, or
// the run can end before they send it. The card then closes, and the words
// they typed must not go with it: they go to the end of the session's composer
// draft. An answer that was sent, or a card nobody typed in, gives nothing back.

const QUESTION = { question: 'Which database?', options: [{ label: 'Postgres' }], multiSelect: false }

function fixture(draft = '') {
  const question: QuestionRequest = { questionId: 'question-1', questions: [QUESTION] }
  const session = {
    status: 'awaiting_input', run: { serverId: 'host-1', provider: 'claude-code' },
    messages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }],
    outboundPrompts: [], currentTurnStartedAt: 1, permissionQueue: [], questionQueue: [question], rateLimitInfo: null,
    prompt: { text: draft, attachments: [], planRefs: [], workRefs: [], sessionRefs: [] },
  } as unknown as Session
  const reducer = new SessionEventReducer({
    registry: { tabIdsBySession: new Map(), tabs: {} },
    sessions: { byId: { session } },
    settings: { rateLimitBehavior: 'ask' },
    workStreamTracker: { sweep: () => {} },
    isSessionVisible: () => true,
    publishSessionViewed: () => {},
    playNotificationIfHidden: () => {},
    closePlanModal: () => {},
    log: () => {},
  } as unknown as SessionEventReducerDeps)
  return { session, reducer, question: session.questionQueue[0] }
}

/** What the card writes on each keystroke in its own-words field. */
function type(question: QuestionRequest, text: string): void {
  (question.remarks ??= {})[QUESTION.question] = text
}

const expire: NormalizedEvent = { type: 'permission_resolved', questionId: 'question-1', expired: 'run_ended' }
const nextTurn: NormalizedEvent = { type: 'status_change', status: 'running' }

for (const provider of ['claude-code', 'codex'] as const) {
  describe(`${provider}: a typed answer to a question that closes unanswered`, () => {
    test('goes to the composer draft when the next turn drops the closed card', () => {
      const { session, reducer, question } = fixture()
      session.run.provider = provider
      type(question, 'Use SQLite for now')
      reducer.apply('session', expire)
      // The closed card still shows, with the text, to say why it closed.
      expect(session.questionQueue).toHaveLength(1)
      expect(session.prompt.text).toBe('')

      reducer.apply('session', nextTurn)
      expect(session.questionQueue).toHaveLength(0)
      expect(session.prompt.text).toBe('Use SQLite for now')
    })
  })
}

describe('a typed answer to a question that closes unanswered', () => {
  test('goes to the composer draft when this client presses Stop', () => {
    const { session, reducer, question } = fixture()
    type(question, 'Use SQLite for now')
    reducer.interruptSession('session')
    expect(session.questionQueue).toHaveLength(0)
    expect(session.prompt.text).toBe('Use SQLite for now')
  })

  test('goes after the draft the user already wrote, with a blank line between them', () => {
    const { session, reducer, question } = fixture('Also add tests\n')
    type(question, '  Use SQLite for now ')
    reducer.apply('session', expire)
    reducer.apply('session', nextTurn)
    expect(session.prompt.text).toBe('Also add tests\n\nUse SQLite for now')
  })

  test('gives nothing back when the user typed nothing, or erased what they typed', () => {
    const untouched = fixture('Draft')
    untouched.reducer.apply('session', expire)
    untouched.reducer.apply('session', nextTurn)
    expect(untouched.session.prompt.text).toBe('Draft')

    const erased = fixture('Draft')
    type(erased.question, 'Postgres?')
    type(erased.question, '   ')
    erased.reducer.interruptSession('session')
    expect(erased.session.prompt.text).toBe('Draft')
  })

  test('gives nothing back for an answer that was sent', () => {
    const answered = fixture()
    type(answered.question, 'Use SQLite for now')
    answered.reducer.apply('session', {
      type: 'question_answered', timestamp: 2,
      answer: { questionId: 'question-1', questions: [QUESTION], answers: { [QUESTION.question]: 'Use SQLite for now' } },
    })
    answered.reducer.interruptSession('session')
    answered.reducer.apply('session', nextTurn)
    expect(answered.session.prompt.text).toBe('')

    const resolved = fixture()
    type(resolved.question, 'Use SQLite for now')
    resolved.reducer.apply('session', { type: 'permission_resolved', questionId: 'question-1' })
    resolved.reducer.apply('session', nextTurn)
    expect(resolved.session.prompt.text).toBe('')
  })

  test('is given back once, even when several paths close the card', () => {
    const { session, reducer, question } = fixture()
    type(question, 'Use SQLite for now')
    reducer.apply('session', expire)
    reducer.apply('session', { type: 'status_change', status: 'idle' })
    reducer.apply('session', nextTurn)
    expect(session.prompt.text).toBe('Use SQLite for now')
  })

  test('stays on a message-mode question, which outlives its run', () => {
    const { session, reducer, question } = fixture()
    question.responseMode = 'message'
    type(question, 'pnpm')
    reducer.interruptSession('session')
    reducer.apply('session', nextTurn)
    expect(session.questionQueue).toEqual([question])
    expect(session.prompt.text).toBe('')
  })
})

describe('the host replaces the open questions after a reconnect', () => {
  const questionEvent: NormalizedEvent = { type: 'question_request', questionId: 'question-1', questions: [QUESTION] }
  const ctx = { clearPlanWaiting: () => {} } as unknown as WorkspaceContext

  test('a question it still holds keeps the typed text in its card', () => {
    const { session, question } = fixture()
    type(question, 'Use SQLite for now')
    syncPendingInputFromEvent(ctx, session, [questionEvent])
    expect(session.questionQueue[0]).not.toBe(question)
    expect(session.questionQueue[0].remarks).toEqual({ [QUESTION.question]: 'Use SQLite for now' })
    expect(session.prompt.text).toBe('')
  })

  test('a question it no longer holds gives the typed text to the composer', () => {
    const { session, question } = fixture()
    type(question, 'Use SQLite for now')
    syncPendingInputFromEvent(ctx, session, [])
    expect(session.questionQueue).toHaveLength(0)
    expect(session.prompt.text).toBe('Use SQLite for now')
  })
})

describe('the draft with the remarks of a closed question', () => {
  // Desktop, web, and mobile all build the recovered draft with this helper.
  test('puts each typed remark after the draft and drops blank ones', () => {
    expect(draftWithUnsentRemarks('', ['A', '', ' B '])).toBe('A\n\nB')
    expect(draftWithUnsentRemarks('Draft  \n', ['A'])).toBe('Draft\n\nA')
    expect(draftWithUnsentRemarks('Draft', ['  '])).toBe('Draft')
  })
})
