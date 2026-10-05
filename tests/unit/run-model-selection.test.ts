import { describe, expect, test } from 'bun:test'
import type { AgentId, RunConfig } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import {
  alignRunProvider,
  inheritRunConfig,
  resolveNewRunConfig,
  runOnModel,
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
    permissionMode: 'full-access',
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
  test('new sessions restore saved tuning instead of resetting the effort', () => {
    // WHY: new-tab and draft creation must use the same remembered choice as
    // the model picker, even when the source session has older options.
    const defaults = run('codex', 'gpt-6-astra')
    const saved = { reasoningEffort: 'max' as const, contextWindow: 1_050_000, fastMode: true }
    const resolved = resolveNewRunConfig(defaults, defaults, {}, { codex: { 'gpt-6-astra': saved } })
    expect(resolved.modelConfig).toEqual({ modelId: 'gpt-6-astra', ...saved })
    expect(inheritRunConfig(defaults, resolved, { codex: { 'gpt-6-astra': saved } }).modelConfig).toEqual(resolved.modelConfig)
  })

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

  test("a task's session starts on the task's host, not the focused tab's", () => {
    // WHY: a task's path names a folder on the host that holds the task. Opening
    // it from the sidebar while a tab on another host has focus must not run the
    // new session on that other host with a path it does not hold.
    const source = {
      ...run('claude-code', 'claude-opus-5'),
      gitContext: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main', worktreePath: '/repo/wt' },
      serverId: 'host-a',
      taskServerId: 'host-a',
    }

    const resolved = resolveNewRunConfig(run('codex', 'gpt-5.6-sol'), source, {
      workingDirectory: '/task/project',
      serverId: 'host-b',
      taskServerId: 'host-b',
    })

    expect(resolved.serverId).toBe('host-b')
    expect(resolved.taskServerId).toBe('host-b')
    expect(resolved.workingDirectory).toBe('/task/project')
    expect(resolved.gitContext).toBeNull()
  })

  test('a cloud task files in the workspace service while it runs elsewhere', () => {
    // WHY: the workspace service owns records but runs nothing. Its task keeps
    // the service as its home; the run stays on an execution host.
    const resolved = resolveNewRunConfig(run('codex', 'gpt-5.6-sol'), run('codex', 'gpt-5.6-sol'), {
      workingDirectory: '/repo',
      taskServerId: 'cloud:org-1',
    })

    expect(resolved.serverId).toBe('local')
    expect(resolved.taskServerId).toBe('cloud:org-1')
  })

  test('ordinary inheritance keeps location but resets session-only choices', () => {
    const defaults = { ...run('codex', 'gpt-5.6-sol'), permissionMode: 'supervised' as const }
    const source = {
      ...run('claude-code', 'claude-opus-5'),
      permissionMode: 'plan' as const,
      worktree: { baseBranch: 'main' },
      pendingHostDispatch: { intent: 'dispatch' as const, serverId: 'remote', repoKey: 'owner/repo' },
    }

    const resolved = resolveNewRunConfig(defaults, source)

    expect(resolved.provider).toBe('claude-code')
    expect(resolved.permissionMode).toBe('supervised')
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

describe('working in a checkout on a managed host', () => {
  test('moving a run to a managed host keeps the checkout unless a worktree was asked for', async () => {
    // WHY: each member has their own clone on a managed host, so working on a
    // branch there is as safe as on their own machine. A worktree is the
    // person's choice, never forced by the host.
    const { withProjectHost, startsWorktree } = await import('@solus/workspace-ui/contexts/workspace/run-config')
    const base = { ...run('codex', 'gpt-5.6-sol'), serverId: 'laptop', taskServerId: 'laptop' }
    const moved = withProjectHost(base, 'team', { path: '/data/projects/web' })
    expect(moved.worktree).toBeNull()
    expect(startsWorktree(moved)).toBe(false)
    const asked = withProjectHost({ ...base, worktree: { baseBranch: 'main' } }, 'team', { path: '/data/projects/web' })
    expect(asked.worktree).toEqual({ baseBranch: null })
  })

  test('a run on another host than its task home starts in the checkout unless a worktree was asked for', async () => {
    // WHY: a cloud task's home is the workspace service, so every run of it is a
    // dispatch. Forcing a worktree there kept people off their default branch.
    const { startsWorktree, withDispatchCheckout, withDispatchWorktree } = await import('@solus/workspace-ui/contexts/workspace/run-config')
    const cloudTask = { ...run('codex', 'gpt-5.6-sol'), serverId: 'managed', taskServerId: 'workspace', worktree: null }
    expect(startsWorktree(cloudTask)).toBe(false)
    const pending = { ...cloudTask, pendingHostDispatch: { serverId: 'managed', intent: 'dispatch' as const, repoKey: 'github.com/acme/web' } }
    const worktree = withDispatchWorktree(pending, null)
    expect(startsWorktree(worktree)).toBe(true)
    const checkout = withDispatchCheckout(worktree)
    expect(startsWorktree(checkout)).toBe(false)
    expect(checkout.pendingHostDispatch).toEqual({ serverId: 'managed', intent: 'dispatch', repoKey: 'github.com/acme/web' })
  })

  test('a lead starts on the lead model with that model\'s own defaults', () => {
    // WHY: Settings → Tasks names the agent and model a task lead runs on. The
    // provider must move with the model, and the outgoing model's tuning must
    // not run the new one.
    const lead = runOnModel(run('codex', 'gpt-5.6-sol'), { provider: 'claude-code', model: 'claude-opus-5' })

    expect(lead.provider).toBe('claude-code')
    expect(lead.modelConfig.modelId).toBe('claude-opus-5')
    expect(lead.workingDirectory).toBe('/repo')
  })

  test('a lead starts at the reasoning level the lead model names', () => {
    const lead = runOnModel(run('codex', 'gpt-5.6-sol'), { provider: 'claude-code', model: 'claude-opus-5', reasoningEffort: 'max' })

    expect(lead.modelConfig.reasoningEffort).toBe('max')
  })
})
