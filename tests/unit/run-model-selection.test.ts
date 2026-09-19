import { describe, expect, test } from 'bun:test'
import type { AgentId, RunConfig } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import {
  alignRunProvider,
  inheritRunConfig,
  resolveNewRunConfig,
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

describe('new run resolution', () => {
  test('an explicit project wins over the source and a fresh-task anchor', () => {
    const defaults = run('codex', 'gpt-5.6-sol')
    const source = {
      ...run('claude-code', 'claude-opus-5'),
      workingDirectory: '/source/worktree',
      gitContext: {
        repoRoot: '/source',
        branch: 'feature',
        targetBranch: 'main',
        worktreePath: '/source/worktree',
      },
      serverId: 'remote',
      taskServerId: 'remote',
      projectGroupPath: '/source',
    }

    const resolved = resolveNewRunConfig(defaults, source, {
      freshTask: true,
      workingDirectory: '/chosen',
    })

    expect(resolved.workingDirectory).toBe('/chosen')
    expect(resolved.gitContext).toBeNull()
    expect(resolved.serverId).toBe('remote')
    expect(resolved.modelConfig.modelId).toBe(defaults.modelConfig.modelId)
  })

  test('ordinary inheritance keeps location but resets session-only choices', () => {
    const defaults = { ...run('codex', 'gpt-5.6-sol'), permissionMode: 'ask' as const }
    const source = {
      ...run('claude-code', 'claude-opus-5'),
      permissionMode: 'plan' as const,
      worktree: { baseBranch: 'main' },
      pendingHostDispatch: { intent: 'dispatch' as const, serverId: 'remote', repoKey: 'owner/repo' },
    }

    const resolved = resolveNewRunConfig(defaults, source)

    expect(resolved.provider).toBe('claude-code')
    expect(resolved.permissionMode).toBe('ask')
    expect(resolved.worktree).toBeNull()
    expect(resolved.pendingHostDispatch).toBeNull()
  })

  test('an explicit Auto choice remains Auto in the next session', () => {
    const defaults = run('codex', 'gpt-5.6-sol')
    const source = run('codex', AUTO_MODEL_ID)
    source.modelConfig.reasoningEffort = 'low'

    const resolved = resolveNewRunConfig(defaults, source)

    expect(resolved.modelConfig.modelId).toBe(AUTO_MODEL_ID)
    expect(resolved.modelConfig.reasoningEffort).toBe('medium')
  })

  test('an explicit host owns both the run and its task', () => {
    const resolved = resolveNewRunConfig(
      run('codex', 'gpt-5.6-sol'),
      { ...run('codex', 'gpt-5.6-sol'), projectGroupPath: '/old' },
      { serverId: 'remote' },
    )

    expect(resolved.serverId).toBe('remote')
    expect(resolved.taskServerId).toBe('remote')
    expect(resolved.projectGroupPath).toBeNull()
  })
})
