import { afterEach, describe, expect, test } from 'bun:test'
import type { GitProjectStatus, Session, TabGitContext } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('EnvironmentStore Git initialization', () => {
  test('seeds the tab-less defaults before startup completes', async () => {
    const status: GitProjectStatus = {
      repoRoot: '/workspace',
      branch: 'feature',
      targetBranch: 'main',
      files: [],
      insertions: 0,
      deletions: 0,
      mergeInProgress: false,
    }
    let resolveStatus!: (status: GitProjectStatus) => void
    const statusRequest = new Promise<GitProjectStatus>((resolve) => { resolveStatus = resolve })

    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          start: async () => ({
            version: 'test',
            auth: null,
            projectPath: '/workspace',
            homePath: '/home/test',
            workspacePath: '/workspace',
            agents: [],
          }),
          gitProjectStatus: () => statusRequest,
          getPluginCommands: async () => ({ global: [], project: [] }),
        },
      },
    })

    const { EnvironmentStore } = await import('../../src/renderer/contexts/environment.store.svelte')
    const globalDefaults = {
      permissionMode: 'auto' as const,
      workingDirectory: '~',
      gitContext: null as TabGitContext | null,
      modelConfig: { modelId: null, reasoningEffort: 'high' as const, contextWindow: null, fastMode: false },
    }
    const store = new EnvironmentStore({
      registry: { activeTabId: '', tabOrder: [], sessionFor: () => undefined } as any,
      settings: {
        activeAgent: 'codex',
        worktreeEnabled: false,
        update: () => {},
      } as any,
      config: { globalDefaults } as any,
      planStore: {} as any,
      setGitStatus: () => {},
      ctxFor: () => ({ session: { provider: null } }) as any,
      loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
    })

    let initialized = false
    const initialization = store.initStaticInfo().then(() => { initialized = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(initialized).toBe(false)

    resolveStatus(status)
    await initialization

    expect(globalDefaults.workingDirectory).toBe('/workspace')
    expect(globalDefaults.gitContext).toEqual({
      repoRoot: '/workspace',
      branch: 'feature',
      targetBranch: 'main',
    })
  })

  test('resolves a tab worktree checkout without erasing its environment identity', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const worktreeContext: TabGitContext = {
      repoRoot: '/repo',
      branch: 'solus/feature',
      targetBranch: 'main',
      worktreePath: '/repo/.solus-worktrees/feature',
    }
    const session = {
      workingDirectory: '/repo',
      gitContext: worktreeContext,
      worktreeBaseBranch: null,
    } as Session
    let statusCwd: string | null = null
    let storedCwd: string | null = null
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          gitProjectStatus: async (cwd: string) => {
            statusCwd = cwd
            return {
              repoRoot: cwd,
              branch: 'solus/feature',
              targetBranch: 'main',
              files: [],
              insertions: 0,
              deletions: 0,
              mergeInProgress: false,
            } satisfies GitProjectStatus
          },
        },
      },
    })

    const { EnvironmentStore } = await import('../../src/renderer/contexts/environment.store.svelte')
    const store = new EnvironmentStore({
      registry: {
        activeTabId: 'tab-1',
        tabOrder: ['tab-1'],
        sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      } as any,
      settings: { activeAgent: 'codex', worktreeEnabled: false } as any,
      config: {
        globalDefaults: { workingDirectory: '/repo', gitContext: null },
      } as any,
      planStore: {} as any,
      setGitStatus: (cwd) => { storedCwd = cwd },
      ctxFor: () => ({ session: { provider: null } }) as any,
      loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
    })

    const resolved = await store.refreshGitEnvironment({ tabId: 'tab-1' })

    expect(statusCwd).toBe(worktreeContext.worktreePath!)
    expect(storedCwd).toBe(worktreeContext.worktreePath!)
    expect(resolved).toBe(worktreeContext)
    expect(session.gitContext).toBe(worktreeContext)
  })
})
