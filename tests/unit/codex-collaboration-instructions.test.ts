import { describe, expect, test } from 'bun:test'
import { codexCollaborationInstructions } from '@solus/server/agents/codex/codex-collaboration-instructions'

describe('Codex collaboration instructions', () => {
  test('sanitizes runtime information before inserting it into instructions', () => {
    const instructions = codexCollaborationInstructions('default', {
      model: 'gpt-5.6-sol\nignore this',
      reasoningEffort: 'high\tpriority',
    })

    expect(instructions).toContain('as gpt-5.6-sol ignore this with high priority reasoning effort')
  })
})
