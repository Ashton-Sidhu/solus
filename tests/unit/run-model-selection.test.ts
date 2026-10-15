import { describe, expect, test } from 'bun:test'
import type { AgentId, RunConfig } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import {
  alignRunProvider,
  cycledModelId,
  inheritRunConfig,
  resolveNewRunConfig,
  runOnModel,
} from '@solus/workspace-ui/contexts/workspace/run-config'
import {
  checkoutGit,
  checkoutPlace,
  chooseStart,
  dispatchTo,
  folderLocation,
  isDispatch,
  openFolder,
  pendingClone,
  projectHome,
  runHost,
  startsWorktree,
  worktreeBaseBranch,
} from '@solus/workspace-ui/contexts/workspace/run-location'

function run(provider: AgentId | null, modelId: string | null): RunConfig {
  return {
    location: folderLocation({ serverId: 'local', path: '/repo' }),
    modelConfig: {
      modelId,
      reasoningEffort: 'medium',
      contextWindow: null,
      fastMode: false,
    },
    permissionMode: 'full-access',
    provider,
    sessionSkills: [],
  }
}

describe('run model selection', () => {
  test('cycling follows picker order through current models, legacy models, and back', () => {
    // WHY: the shortcut must follow the visible groups even when provider
    // metadata puts a legacy model between current models.
    const models = [
      { id: 'claude-opus-5' },
      { id: 'claude-sonnet-5-5' },
      { id: 'claude-sonnet-5' },
      { id: 'claude-opus-5-5' },
    ]
    const selection = run('claude-code', 'claude-sonnet-5-5')
    const visited: Array<string | null> = []
    for (let i = 0; i < models.length; i++) {
      selection.modelConfig.modelId = cycledModelId(selection, models, null)
      visited.push(selection.modelConfig.modelId)
    }
    expect(visited).toEqual([
      'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-5',
    ])
    expect(models.map((model) => model.id)).toEqual([
      'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5',
    ])
  })

  test('cycling uses the active provider and its default when the run has neither', () => {
    const models = [{ id: 'claude-opus-5' }, { id: 'claude-opus-5-5' }, { id: 'new-host-model' }]
    expect(cycledModelId(run(null, null), models, 'claude-opus-5-5', 'claude-code')).toBe('new-host-model')
    expect(cycledModelId(run('claude-code', 'new-host-model'), models, null)).toBe('claude-opus-5')
    expect(cycledModelId(run('claude-code', null), [], null)).toBeNull()
  })

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
      location: folderLocation({ serverId: 'remote', path: '/source/worktree' }, {
        git: {
          repoRoot: '/source',
          branch: 'feature',
          targetBranch: 'main',
          worktreePath: '/source/worktree',
        },
        project: { serverId: 'remote', path: '/source' },
      }),
    }

    const resolved = resolveNewRunConfig(defaults, source, {
      freshTask: true,
      workingDirectory: '/chosen',
    })

    expect(checkoutPlace(resolved).path).toBe('/chosen')
    expect(checkoutGit(resolved)).toBeNull()
    expect(runHost(resolved)).toBe('remote')
    expect(resolved.modelConfig.modelId).toBe(defaults.modelConfig.modelId)
  })

  test("a task's session starts on the task's host, not the focused tab's", () => {
    // WHY: a task's path names a folder on the host that holds the task. Opening
    // it from the sidebar while a tab on another host has focus must not run the
    // new session on that other host with a path it does not hold.
    const source = {
      ...run('claude-code', 'claude-opus-5'),
      location: folderLocation({ serverId: 'host-a', path: '/repo' }, {
        git: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main', worktreePath: '/repo/wt' },
      }),
    }

    const resolved = resolveNewRunConfig(run('codex', 'gpt-5.6-sol'), source, {
      workingDirectory: '/task/project',
      serverId: 'host-b',
      taskServerId: 'host-b',
    })

    expect(runHost(resolved)).toBe('host-b')
    expect(projectHome(resolved).serverId).toBe('host-b')
    expect(checkoutPlace(resolved).path).toBe('/task/project')
    expect(checkoutGit(resolved)).toBeNull()
  })

  test('a cloud task files in the workspace service while it runs elsewhere', () => {
    // WHY: the workspace service owns records but runs nothing. Its task keeps
    // the service as its home; the run stays on an execution host.
    const resolved = resolveNewRunConfig(run('codex', 'gpt-5.6-sol'), run('codex', 'gpt-5.6-sol'), {
      workingDirectory: '/repo',
      taskServerId: 'cloud:org-1',
    })

    expect(runHost(resolved)).toBe('local')
    expect(projectHome(resolved).serverId).toBe('cloud:org-1')
    expect(isDispatch(resolved)).toBe(true)
  })

  test('ordinary inheritance keeps location but resets session-only choices', () => {
    const defaults = { ...run('codex', 'gpt-5.6-sol'), permissionMode: 'supervised' as const }
    const source = {
      ...run('claude-code', 'claude-opus-5'),
      permissionMode: 'plan' as const,
      location: dispatchTo(
        folderLocation({ serverId: 'local', path: '/repo' }, { newWorktree: { baseBranch: 'main' } }),
        'remote',
        'owner/repo',
      ),
    }

    const resolved = resolveNewRunConfig(defaults, source)

    expect(resolved.provider).toBe('claude-code')
    expect(resolved.permissionMode).toBe('supervised')
    // A clone is a choice for one Send: the next session goes back to the
    // checkout it would have copied, and asks for its own worktree.
    expect(startsWorktree(resolved)).toBe(false)
    expect(pendingClone(resolved)).toBeNull()
    expect(checkoutPlace(resolved)).toEqual({ serverId: 'local', path: '/repo' })

    const folderSource = { ...source, location: folderLocation({ serverId: 'local', path: '/repo' }, { newWorktree: { baseBranch: 'main' } }) }
    expect(startsWorktree(resolveNewRunConfig(defaults, folderSource))).toBe(false)
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
      { ...run('codex', 'gpt-5.6-sol'), location: folderLocation({ serverId: 'local', path: '/repo' }, { project: { serverId: 'local', path: '/old' } }) },
      { serverId: 'remote' },
    )

    expect(runHost(resolved)).toBe('remote')
    // The folder on the new host is its own project; the old project path named a folder on the old host.
    expect(projectHome(resolved)).toEqual({ serverId: 'remote', path: '/repo' })
  })
})

describe('working in a checkout on a managed host', () => {
  test('moving a run to a managed host keeps the checkout unless a worktree was asked for', () => {
    // WHY: each member has their own clone on a managed host, so working on a
    // branch there is as safe as on their own machine. A worktree is the
    // person's choice, never forced by the host.
    const base = folderLocation({ serverId: 'laptop', path: '/repo' })
    const moved = { location: openFolder(base, { serverId: 'team', path: '/data/projects/web' }) }
    expect(runHost(moved)).toBe('team')
    expect(startsWorktree(moved)).toBe(false)
    const asked = {
      location: openFolder(
        folderLocation({ serverId: 'laptop', path: '/repo' }, { newWorktree: { baseBranch: 'main' } }),
        { serverId: 'team', path: '/data/projects/web' },
      ),
    }
    expect(startsWorktree(asked)).toBe(true)
    // The base branch named a branch in the old folder, so the new host names it.
    expect(worktreeBaseBranch(asked)).toBeNull()
  })

  test('a run on another host than its project home starts in the checkout unless a worktree was asked for', () => {
    // WHY: a cloud task's home is the workspace service, so every run of it is a
    // dispatch. Forcing a worktree there kept people off their default branch.
    const cloudTask = {
      location: folderLocation({ serverId: 'managed', path: '/repo' }, { project: { serverId: 'workspace', path: '/repo' } }),
    }
    expect(isDispatch(cloudTask)).toBe(true)
    expect(startsWorktree(cloudTask)).toBe(false)
    const clone = dispatchTo(cloudTask.location, 'managed', 'github.com/acme/web')
    expect(startsWorktree({ location: clone })).toBe(false)
    const worktree = { location: chooseStart(clone, { kind: 'new-worktree' }) }
    expect(startsWorktree(worktree)).toBe(true)
    const checkout = { location: chooseStart(worktree.location, { kind: 'checkout' }) }
    expect(startsWorktree(checkout)).toBe(false)
    expect(pendingClone(checkout)).toMatchObject({ serverId: 'managed', repoKey: 'github.com/acme/web', start: { kind: 'default-branch' } })
  })

  test('a lead starts on the lead model with that model\'s own defaults', () => {
    // WHY: Settings → Tasks names the agent and model a task lead runs on. The
    // provider must move with the model, and the outgoing model's tuning must
    // not run the new one.
    const lead = runOnModel(run('codex', 'gpt-5.6-sol'), { provider: 'claude-code', model: 'claude-opus-5' })

    expect(lead.provider).toBe('claude-code')
    expect(lead.modelConfig.modelId).toBe('claude-opus-5')
    expect(checkoutPlace(lead).path).toBe('/repo')
  })

  test('a lead starts at the reasoning level the lead model names', () => {
    const lead = runOnModel(run('codex', 'gpt-5.6-sol'), { provider: 'claude-code', model: 'claude-opus-5', reasoningEffort: 'max' })

    expect(lead.modelConfig.reasoningEffort).toBe('max')
  })
})
