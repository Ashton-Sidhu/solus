import { describe, expect, test } from 'bun:test'
import type { AgentId, RunConfig } from '@solus/contracts/types'
import {
  alignRunProvider,
  inheritRunConfig,
} from '@solus/workspace-ui/contexts/workspace/run-config'

function run(provider: AgentId | null, modelId: string | null): RunConfig {
  return {
    workingDirectory: '/repo',
    gitContext: null,
    worktree: null,
    modelConfig: {
      modelId,
      reasoningEffort: 'medium',
      contextWindow: null,
      fastMode: false,
    },
    permissionMode: 'auto',
    provider,
    serverId: 'local',
    taskServerId: 'local',
    projectGroupPath: null,
    sessionSkills: [],
    pendingHostDispatch: null,
  }
}

describe('run model selection', () => {
  test('an explicit model supplies the missing provider on legacy drafts', () => {
    // WHY: provider and model are one choice. The current default must not put
    // its glyph beside a saved model owned by another provider.
    const normalized = alignRunProvider(run(null, 'claude-opus-5'), 'codex')

    expect(normalized.provider).toBe('claude-code')
    expect(normalized.modelConfig.modelId).toBe('claude-opus-5')
  })

  test('a known model repairs a stale explicit provider', () => {
    // WHY: a known model has one owner. Keeping the mismatched provider is what
    // lets the picker show one provider's mark beside another provider's model.
    const normalized = alignRunProvider(run('codex', 'claude-opus-5'), 'codex')

    expect(normalized.provider).toBe('claude-code')
    expect(normalized.modelConfig.modelId).toBe('claude-opus-5')
  })

  test('draft inheritance normalizes the pair before the draft can render', () => {
    const inherited = inheritRunConfig(
      run('codex', 'gpt-5.6-sol'),
      run(null, 'claude-opus-5'),
    )

    expect(inherited.provider).toBe('claude-code')
    expect(inherited.modelConfig.modelId).toBe('claude-opus-5')
  })
})
