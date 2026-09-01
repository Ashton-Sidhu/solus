import { describe, expect, test } from 'bun:test'
import { runInputFromContext } from '@solus/server/agents/run-input'
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
    permissionMode: 'auto',
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
  test('marks a cross-host run as dispatched in SessionCtx', () => {
    const run = {
      workingDirectory: '/remote/repo',
      gitContext: null,
      worktree: { baseBranch: 'main' },
      modelConfig: { modelId: 'model', reasoningEffort: 'high', contextWindow: null, fastMode: false },
      permissionMode: 'ask',
      provider: 'codex',
      serverId: 'execution-host',
      taskServerId: 'project-host',
    }
    const deps = {
      sessionFor: () => undefined,
      runFor: () => run,
      hasDraft: () => false,
      globalDefaults: {
        permissionMode: 'ask', workingDirectory: '/repo', gitContext: null, worktreeBaseBranch: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
      staticInfo: () => null,
      window: { viewMode: 'editor' },
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
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: null,
        modelConfig: {
          modelId: null,
          reasoningEffort: 'high',
          contextWindow: null,
          fastMode: false,
        },
      },
      staticInfo: () => null,
      window: { viewMode: 'editor' },
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
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
      staticInfo: () => null,
      window: { viewMode: 'editor' },
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
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: null,
        worktreeBaseBranch: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
      staticInfo: () => null,
      window: { viewMode: 'editor' },
      settings: { ctx: { activeAgent: 'codex' } },
      statusBar: { ctx: statusBar('model', 'high'), ctxFor: () => statusBar('model', 'high') },
    } as unknown as IpcContextBuilderDeps

    const ctx = new IpcContextBuilder(deps).forEnvironment('', checkout.worktreePath, checkout)

    // No session behind it, so the host is told to register nothing.
    expect(ctx.session.sessionId).toBe('')
    expect(ctx.session.workingDirectory).toBe(checkout.worktreePath)
    expect(ctx.session.gitContext).toEqual(checkout)
  })
})
