import { describe, expect, test } from 'bun:test'
import { runInputFromContext } from '../../src/main/agents/run-input'
import { IpcContextBuilder, type IpcContextBuilderDeps } from '../../src/renderer/contexts/workspace/ipc-context'
import type { StatusBarCtx } from '../../src/shared/types'

function statusBar(model: string, reasoningEffort: StatusBarCtx['reasoningEffort']): StatusBarCtx {
  return {
    workingDirectory: '/repo',
    activeAgent: 'codex',
    permissionMode: 'auto',
    model,
    reasoningEffort,
    defaultReasoningEffort: 'high',
    reasoningLevels: ['low', 'medium', 'high'],
    supportsFastMode: false,
    fastMode: false,
    contextWindows: [200_000],
  }
}

describe('IPC context', () => {
  test("a split tab runs with its own status bar's model and reasoning", () => {
    const primaryStatus = statusBar('primary-model', 'high')
    const splitStatus = statusBar('split-model', 'low')
    const deps = {
      tabs: () => ({}),
      sessionFor: () => undefined,
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
  })

  test('an environment context carries its checkout without a tab', () => {
    const checkout = {
      repoRoot: '/repo',
      worktreePath: '/repo/.solus-worktrees/feature',
      branch: 'feature',
      targetBranch: 'main',
    }
    const deps = {
      tabs: () => ({}),
      sessionFor: () => undefined,
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

    expect(ctx.session.tabId).toBe('')
    expect(ctx.session.workingDirectory).toBe(checkout.worktreePath)
    expect(ctx.session.gitContext).toEqual(checkout)
  })
})
