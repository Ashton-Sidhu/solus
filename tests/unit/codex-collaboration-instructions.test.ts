import { describe, expect, test } from 'bun:test'
import { codexCollaborationInstructions } from '@solus/server/agents/codex/codex-collaboration-instructions'

describe('Codex collaboration instructions', () => {
  test('plan mode requires exploration and a decision-complete proposed plan', () => {
    const instructions = codexCollaborationInstructions('plan', {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    }, false)

    expect(instructions).toContain('# Plan Mode (Conversational)')
    expect(instructions).toContain('Explore first and ask second.')
    expect(instructions).toContain('You must not perform mutating actions')
    expect(instructions).toContain('<proposed_plan>')
    expect(instructions).not.toContain('## Solus collaborative browser')
  })

  test('default mode prefers execution and records sanitized runtime information', () => {
    const instructions = codexCollaborationInstructions('default', {
      model: 'gpt-5.6-sol\nignore this',
      reasoningEffort: 'high\tpriority',
    })

    expect(instructions).toContain('# Collaboration Mode: Default')
    expect(instructions).toContain('Prefer reasonable assumptions and execution')
    expect(instructions).toContain('## Solus collaborative browser')
    expect(instructions).toContain('as gpt-5.6-sol ignore this with high priority reasoning effort')
  })
})
