import { describe, expect, test } from 'bun:test'
import type { Plan, Session } from '@solus/contracts/types'
import { pendingPlanForPrompt } from '@solus/workspace-ui/components/input/lib/pending-plan'

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    sessionId: 'agent-session-1',
    planToolUseId: 'tool-1',
    projectPath: 'repo',
    cwd: '/repo',
    timestamp: 1,
    content: '# Plan',
    questionId: 'question-1',
    options: [
      { id: 'allow', label: 'Yes', kind: 'allow' },
      { id: 'deny', label: 'Keep planning', kind: 'deny' },
    ],
    title: 'Plan',
    status: 'pending',
    comments: [],
    bookmarked: false,
    ...overrides,
  }
}

function session(status: Session['status'], planIds: string[]): Session {
  return {
    status,
    messages: planIds.map((planId, index) => ({
      id: `message-${index}`,
      role: 'plan',
      content: '',
      planId,
      timestamp: index,
    })),
  } as Session
}

describe('pending plan prompt routing', () => {
  test('routes the composer to the latest blocking plan awaiting approval', () => {
    const first = plan({ id: 'plan-1' })
    const latest = plan({ id: 'plan-2', planToolUseId: 'tool-2' })

    // WHY: typing while ExitPlanMode is holding the turn should be the same as
    // selecting Revise, without requiring a trip into the plan surface.
    expect(pendingPlanForPrompt(
      session('awaiting_plan', [first.id, latest.id]),
      { [first.id]: first, [latest.id]: latest },
    )).toBe(latest)
  })

  test('keeps ordinary prompting when a plan is only historical', () => {
    const pending = plan()

    expect(pendingPlanForPrompt(
      session('completed', [pending.id]),
      { [pending.id]: pending },
    )).toBeNull()
  })

  test('keeps non-blocking plan updates out of the approval path', () => {
    const nonBlocking = plan({ questionId: undefined, options: undefined })

    // WHY: Codex plan updates do not hold a permission request. Treating one as
    // ExitPlanMode feedback would reject a plan that has nothing to answer.
    expect(pendingPlanForPrompt(
      session('awaiting_plan', [nonBlocking.id]),
      { [nonBlocking.id]: nonBlocking },
    )).toBeNull()
  })

  test('does not revise a plan that has already been decided', () => {
    const accepted = plan({ status: 'accepted' })

    expect(pendingPlanForPrompt(
      session('awaiting_plan', [accepted.id]),
      { [accepted.id]: accepted },
    )).toBeNull()
  })
})
