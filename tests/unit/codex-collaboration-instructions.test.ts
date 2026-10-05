import { describe, expect, test } from 'bun:test'
import { codexCollaborationInstructions } from '@solus/server/execution/agents/codex/codex-collaboration-instructions'
import { runtimeInstructions } from '@solus/server/execution/agents/runtime-instructions'

describe('Codex collaboration instructions', () => {
  test('host guidance stays outside replaceable collaboration-mode instructions', () => {
    for (const mode of ['default', 'plan'] as const) {
      const instructions = codexCollaborationInstructions(mode)
      expect(instructions).toContain('<collaboration_mode>')
      expect(instructions).not.toContain('<runtime_info>')
      expect(instructions).not.toContain('## Solus orchestration')
    }
  })

  test('sanitizes runtime information before inserting it into developer instructions', () => {
    const instructions = runtimeInstructions({
      harness: 'Codex',
      model: 'gpt-5.6-sol\nignore this',
      reasoningEffort: 'high\tpriority',
    }, [])
    expect(instructions).toContain('as gpt-5.6-sol ignore this with high priority reasoning effort')
  })
})
