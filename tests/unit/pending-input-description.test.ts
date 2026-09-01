import { describe, expect, test } from 'bun:test'
import { describePendingInput } from '@solus/server/sessions/pending-input'
import type { NormalizedEvent } from '@solus/contracts/types'

/**
 * The one structural read of a peer's pause. Everything that differs between
 * Claude and Codex has to be resolved FROM THE EVENT — the moment a provider's
 * vocabulary gets hardcoded, the other provider silently answers the wrong
 * option or is told a finished turn is still blocking.
 */

function claudePlan(): NormalizedEvent {
  return {
    type: 'plan',
    planContent: '# Ship it\nStep one.',
    planFilePath: '',
    questionId: 'perm-1',
    planToolUseId: 'toolu_1',
    options: [
      { id: 'allow', label: 'Yes', kind: 'allow' },
      { id: 'deny', label: 'No', kind: 'deny' },
    ],
  }
}

function codexPlan(content: string): NormalizedEvent {
  return { type: 'plan', planContent: content, planFilePath: '', questionId: 'codex-9', planToolUseId: 'plan-9', options: [] }
}

describe('describePendingInput', () => {
  test("a Claude ExitPlanMode plan is blocking, with the event's own allow/deny ids", () => {
    // WHY: 'allow'/'deny' must never be written into the tool — Codex answers
    // 'accept'/'decline' and would be handed a decision it fails closed on.
    const described = describePendingInput([claudePlan()])
    expect(described).toMatchObject({
      kind: 'plan',
      questionId: 'perm-1',
      planToolUseId: 'toolu_1',
      blocking: true,
      allowOptionId: 'allow',
      denyOptionId: 'deny',
    })
  })

  test('a Codex plan carries no options, so it is not blocking and has no ids to answer', () => {
    // WHY: `blocking` is the whole reason approval branches. A Codex plan
    // arrives after turn/completed — there is no held request to respond to, so
    // approving it can only mean sending a follow-up prompt.
    const described = describePendingInput([codexPlan('plan a')])
    expect(described).toMatchObject({ kind: 'plan', blocking: false })
    expect((described as any).allowOptionId).toBeUndefined()
    expect((described as any).denyOptionId).toBeUndefined()
  })

  test('several queued Codex plan revisions collapse to the latest', () => {
    // WHY: Codex re-emits a plan per turn/plan/updated. Approving the first one
    // would implement a draft the peer has already replaced.
    const described = describePendingInput([codexPlan('draft'), codexPlan('revised'), codexPlan('final')])
    expect(described).toMatchObject({ kind: 'plan', planContent: 'final' })
  })

  test('a tool permission request describes as a permission, never as something answerable', () => {
    // WHY: this is the discriminator the answer tools refuse on. If a permission
    // ever described as a question, an agent could grant a peer Bash access.
    const described = describePendingInput([
      { type: 'permission_request', questionId: 'perm-2', toolName: 'Bash', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }] },
    ])
    expect(described).toEqual({ kind: 'permission', toolName: 'Bash' })
  })

  test('questions carry their answer key and option labels; MCP elicitation is flagged', () => {
    // WHY: `isMcpElicitation` decides whether `__action` is sent. Without it
    // Codex declines the form and the answer is silently thrown away.
    const described = describePendingInput([
      {
        type: 'question_request',
        questionId: 'q-1',
        kind: 'mcp_form',
        questions: [{ id: 'branch', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }], multiSelect: false }],
      },
    ])
    expect(described).toEqual({
      kind: 'question',
      questionId: 'q-1',
      isMcpElicitation: true,
      questions: [{ key: 'branch', question: 'Which branch?', options: ['main', 'dev'], multiSelect: false }],
    })
  })

  test('a question with no id keys on its text, exactly as the card does', () => {
    const described = describePendingInput([
      { type: 'question_request', questionId: 'q-2', questions: [{ question: 'Snapshot or lock?', options: [], multiSelect: false }] },
    ])
    expect(described).toMatchObject({ isMcpElicitation: false, questions: [{ key: 'Snapshot or lock?' }] })
  })

  test('nothing pending describes as null', () => {
    expect(describePendingInput([])).toBeNull()
    expect(describePendingInput([{ type: 'text_chunk', text: 'hi' }])).toBeNull()
  })
})
