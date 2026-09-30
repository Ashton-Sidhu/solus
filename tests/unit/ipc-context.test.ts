import { describe, expect, test } from 'bun:test'
import { runInputFromContext } from '@solus/server/execution/agents/run-input'
import { IpcContextBuilder, type IpcContextBuilderDeps } from '@solus/workspace-ui/contexts/workspace/ipc-context'
import type { StatusBarCtx } from '@solus/contracts/types'

function statusBar(
  model: string,
  reasoningEffort: StatusBarCtx['reasoningEffort'],
  fastMode = false,
): StatusBarCtx {
  return {
    workingDirectory: '/repo',
    activeAgent: 'codex',
    permissionMode: 'full-access',
    model,
    reasoningEffort,
    defaultReasoningEffort: 'high',
    reasoningLevels: ['low', 'medium', 'high'],
    supportsFastMode: false,
    fastMode,
    contextWindows: [200_000],
  }
}

describe('IPC context', () => {
  test('outbound prompts use current checkout identity and honor removal', () => {
    const run = {
      workingDirectory: '/repo/tree',
      gitContext: { repoRoot: '/repo', worktreePath: '/repo/tree', branch: 'temporary', targetBranch: 'main' },
      worktree: null, permissionMode: 'full-access', provider: 'codex', serverId: 'host',
      modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    }
    const current = { ...run.gitContext, branch: 'renamed' }
    const deps = {
      sessionFor: () => undefined, runFor: () => run, hasDraft: () => false,
      defaultRunConfig: () => run,
      checkoutForRun: () => current,
    } as unknown as IpcContextBuilderDeps
    const builder = new IpcContextBuilder(deps)
    expect(builder.sessionCtx('draft').gitContext?.branch).toBe('renamed')
    deps.checkoutForRun = () => null
    expect(builder.sessionCtx('draft').gitContext).toBeNull()
    expect(run.gitContext.branch).toBe('temporary')
  })

  test('marks a cross-host run as dispatched in SessionCtx', () => {
    const run = {
      workingDirectory: '/remote/repo',
      gitContext: null,
      worktree: { baseBranch: 'main' },
      modelConfig: { modelId: 'model', reasoningEffort: 'high', contextWindow: null, fastMode: false },
      permissionMode: 'supervised',
      provider: 'codex',
      serverId: 'execution-host',
      taskServerId: 'project-host',
    }
    const deps = {
      sessionFor: () => undefined,
      runFor: () => run,
      hasDraft: () => false,
      defaultRunConfig: () => ({
        workingDirectory: '/repo', gitContext: null, worktree: null, permissionMode: 'full-access', provider: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      }),
      settings: { ctx: { activeAgent: 'codex' } },
      statusBar: { ctx: statusBar('model', 'high'), ctxFor: () => statusBar('model', 'high') },
    } as unknown as IpcContextBuilderDeps

    expect(new IpcContextBuilder(deps).sessionCtx('draft').origin).toBe('dispatch')
  })

  test("a split tab runs with its own status bar's model and reasoning", () => {
    const primaryStatus = statusBar('primary-model', 'high')
    const splitStatus = statusBar('split-model', 'low', true)
    const deps = {
      tabs: () => ({}),
      sessionFor: () => undefined,
      runFor: () => undefined,
      hasDraft: () => false,
      defaultRunConfig: () => ({
        workingDirectory: '/repo', gitContext: null, worktree: null, permissionMode: 'full-access', provider: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      }),
      settings: {
        activeAgent: 'codex',
        ctx: {
          activeAgent: 'codex',
          rateLimitBehavior: 'queue',
          extraInstructions: '',
          modelInstructions: {},
        },
      },
      statusBar: {
        ctx: primaryStatus,
        ctxFor: (tabId: string) => tabId === 'split-tab' ? splitStatus : primaryStatus,
      },
    } as unknown as IpcContextBuilderDeps

    const runInput = runInputFromContext(new IpcContextBuilder(deps).forTab('split-tab'))

    expect(runInput.model).toBe('split-model')
    expect(runInput.reasoningEffort).toBe('low')
    expect(runInput.fastMode).toBe(true)
  })

  // A draft composes for a conversation the host has never heard of, so it has
  // to name itself: host-side per-conversation storage (an attachment upload)
  // has no other bucket to file under before the session starts.
  test('a draft names itself when there is no session yet', () => {
    const deps = {
      sessionFor: () => undefined,
      runFor: () => undefined,
      hasDraft: (sourceId: string) => sourceId === 'draft-1',
      defaultRunConfig: () => ({
        workingDirectory: '/repo', gitContext: null, worktree: null, permissionMode: 'full-access', provider: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      }),
      settings: { ctx: { activeAgent: 'codex' } },
      statusBar: { ctx: statusBar('model', 'high'), ctxFor: () => statusBar('model', 'high') },
    } as unknown as IpcContextBuilderDeps
    const builder = new IpcContextBuilder(deps)

    expect(builder.sessionCtx('draft-1').draftId).toBe('draft-1')
    // A tab that simply has no session yet is not a draft and mints no bucket.
    expect(builder.sessionCtx('tab-1').draftId).toBeUndefined()
  })

  test('an environment context carries its checkout without a tab', () => {
    const checkout = {
      repoRoot: '/repo',
      worktreePath: '/repo/.git/solus/worktrees/feature',
      branch: 'feature',
      targetBranch: 'main',
    }
    const deps = {
      tabs: () => ({}),
      sessionFor: () => undefined,
      runFor: () => undefined,
      defaultRunConfig: () => ({
        workingDirectory: '/repo', gitContext: null, worktree: null, permissionMode: 'full-access', provider: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      }),
      settings: { ctx: { activeAgent: 'codex' } },
      statusBar: { ctx: statusBar('model', 'high'), ctxFor: () => statusBar('model', 'high') },
    } as unknown as IpcContextBuilderDeps

    const ctx = new IpcContextBuilder(deps).forEnvironment('', checkout.worktreePath, checkout)

    // No session behind it, so the host is told to register nothing.
    expect(ctx.session.sessionId).toBe('')
    expect(ctx.session.workingDirectory).toBe(checkout.worktreePath)
    expect(ctx.session.gitContext).toEqual(checkout)
  })

  // WHY: Insights reads a turn's change for a session that may have no tab.
  // Any thread or checkout in the context would be the default run's — another
  // session's — and the host would read that session's change as this turn's.
  test('a session-record context names the session and nothing that could be another session’s', () => {
    const deps = {
      sessionFor: () => undefined,
      runFor: () => undefined,
      hasDraft: () => false,
      defaultRunConfig: () => ({
        workingDirectory: '/elsewhere', gitContext: { repoRoot: '/elsewhere', branch: 'other', targetBranch: 'main' },
        worktree: null, permissionMode: 'full-access', provider: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      }),
      settings: { ctx: { activeAgent: 'codex' } },
      statusBar: { ctx: statusBar('model', 'high'), ctxFor: () => statusBar('model', 'high') },
    } as unknown as IpcContextBuilderDeps

    const ctx = new IpcContextBuilder(deps).forSessionRecord('session-1')

    expect(ctx.session).toMatchObject({
      sessionId: 'session-1',
      agentSessionId: null,
      workingDirectory: '',
      projectPath: '',
      gitContext: null,
    })
  })
})
