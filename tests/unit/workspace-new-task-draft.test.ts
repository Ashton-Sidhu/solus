import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousAudio = globalThis.Audio

function installRendererGlobals(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  globalThis.Audio = class {
    currentTime = 0
    play() { return Promise.resolve() }
  } as unknown as typeof Audio
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      solus: { getPlatform: () => 'desktop' },
    },
  })
}

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousAudio === undefined) delete (globalThis as unknown as { Audio?: typeof Audio }).Audio
  else globalThis.Audio = previousAudio
})

describe('new tab draft', () => {
  test('stays out of the tab/task projection until the first prompt is submitted', async () => {
    installRendererGlobals()
    let runtimeTabCreations = 0
    Object.assign(window.solus, {
      createTab: async (tabId: string) => {
        runtimeTabCreations++
        return { tabId }
      },
      prompt: async () => {},
      trackRecentProject: async () => {},
    })
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      agentSessionId: 'agent-session',
      serverId: 'local',
      provider: 'codex',
      workingDirectory: '/repo',
      gitContext: { repoRoot: '/repo', branch: 'feature/tasks', targetBranch: 'main' },
      modelConfig: { modelId: 'gpt-5', reasoningEffort: 'high', contextWindow: null, fastMode: false },
      sessionSkills: [],
    } as unknown as Session
    const sourceTab = { id: 'source-tab', sessionId: sourceSession.id } as Tab
    const registry = {
      tabs: { [sourceTab.id]: sourceTab } as Record<string, Tab>,
      sessions: { [sourceSession.id]: sourceSession } as Record<string, Session>,
      tabOrder: [sourceTab.id],
      activeTabId: sourceTab.id,
      get activeSession() { return this.sessions[this.tabs[this.activeTabId]?.sessionId] },
    }
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.draftTabId = null
    workspace.router = { asidePanes: [], chatTabIn: () => null }
    workspace.lifecycle = {
      staticInfo: { projectPath: '/repo', workspacePath: '/repo' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.ui = { isExpanded: true }
    workspace.settings = {
      activeAgent: 'codex',
      rateLimitBehavior: 'ask',
      worktreeEnabled: false,
    }
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: sourceSession.gitContext,
        worktreeBaseBranch: null,
        modelConfig: sourceSession.modelConfig,
      },
      defaultReasoningEffortFor: () => 'high',
      pendingSessionStartTarget: () => null,
    }
    workspace.tasksStore = {
      taskForSession: () => ({ id: 'task-root' }),
      tasks: [{ id: 'task-root' }],
    }
    workspace.promptComposer = {
      compose: (prompt: string) => prompt,
      composeImages: () => [],
    }
    workspace.eventReducer = { closeAgentConversationTurn: () => {} }
    workspace.environment = { refreshTab: async () => {} }
    workspace.refreshPluginCommands = async () => {}
    workspace.resetOverlays = () => {}
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    workspace.addTabToOrder = (tabId: string) => registry.tabOrder.push(tabId)

    const draftTabId = await workspace.createDraftTab(undefined, { via: 'keybinding' })
    const draftSession = workspace.sessionFor(draftTabId)

    // WHY: the sidebar projects task rows from tabOrder. Keeping the local draft
    // out of that array prevents the branch name from appearing as a fake task.
    expect(registry.tabOrder).toEqual(['source-tab'])
    expect(registry.activeTabId).toBe(draftTabId)
    // WHY: structural persistence deliberately excludes the local-only draft.
    // Its active pointer must therefore keep naming the last durable tab or the
    // next refresh restores a snapshot whose active tab does not exist.
    expect(workspace.durableActiveTabId).toBe('source-tab')
    expect(draftSession?.pendingTaskId).toBe('task-root')
    expect(runtimeTabCreations).toBe(0)

    draftSession.status = 'idle'
    expect(workspace.sendMessage('Implement it', undefined, draftTabId)).toBe(true)

    expect(registry.tabOrder).toEqual(['source-tab', draftTabId])
    expect(workspace.draftTabId).toBeNull()
    expect(workspace.durableActiveTabId).toBe(draftTabId)

    workspace.handleError = () => {}
    workspace.ctxFor = () => ({})
    await Promise.resolve()
    expect(runtimeTabCreations).toBe(1)
  })

  test('starts a fresh task from project context and global defaults only', async () => {
    installRendererGlobals()
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      agentSessionId: 'agent-session',
      serverId: 'remote-host',
      provider: 'codex',
      workingDirectory: '/repo/.worktrees/feature',
      gitContext: {
        repoRoot: '/repo',
        worktreePath: '/repo/.worktrees/feature',
        branch: 'feature/tasks',
        targetBranch: 'main',
      },
      modelConfig: { modelId: 'gpt-5', reasoningEffort: 'high', contextWindow: 400_000, fastMode: true },
      sessionSkills: ['source-only-skill'],
    } as unknown as Session
    const sourceTab = { id: 'source-tab', sessionId: sourceSession.id } as Tab
    const registry = {
      tabs: { [sourceTab.id]: sourceTab } as Record<string, Tab>,
      sessions: { [sourceSession.id]: sourceSession } as Record<string, Session>,
      tabOrder: [sourceTab.id],
      activeTabId: sourceTab.id,
      get activeSession() { return this.sessions[this.tabs[this.activeTabId]?.sessionId] },
    }
    const globalModelConfig = {
      modelId: 'claude-sonnet-4-5',
      reasoningEffort: 'medium',
      contextWindow: 200_000,
      fastMode: false,
    }
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.draftTabId = null
    workspace.router = { asidePanes: [], chatTabIn: () => null }
    workspace.lifecycle = {
      staticInfo: { projectPath: '/fallback-project', workspacePath: '/workspace' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.ui = { isExpanded: true }
    workspace.settings = {
      activeAgent: 'claude-code',
      rateLimitBehavior: 'ask',
      worktreeEnabled: true,
    }
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/global-default',
        gitContext: null,
        worktreeBaseBranch: null,
        modelConfig: globalModelConfig,
      },
      defaultReasoningEffortFor: () => 'medium',
    }
    workspace.tasksStore = {
      taskForSession: () => ({ id: 'task-root' }),
      tasks: [{ id: 'task-root' }],
    }
    let refreshOptions: { tabId: string; worktreeRequested: boolean } | undefined
    workspace.environment = {
      refreshTab: async (_workspace: unknown, options: { tabId: string; worktreeRequested: boolean }) => {
        refreshOptions = options
      },
    }
    workspace.refreshPluginCommands = async () => {}
    workspace.resetOverlays = () => {}
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    workspace.addTabToOrder = (tabId: string) => {
      if (!registry.tabOrder.includes(tabId)) registry.tabOrder.push(tabId)
    }

    const draftTabId = await workspace.createDraftTab(undefined, { freshTask: true })
    const draftSession = workspace.sessionFor(draftTabId)

    expect(draftSession?.provider).toBe('claude-code')
    expect(draftSession?.modelConfig).toEqual(globalModelConfig)
    expect(draftSession?.sessionSkills).toEqual([])
    expect(draftSession?.serverId).toBe('local')
    expect(draftSession?.workingDirectory).toBe('/repo')
    expect(draftSession?.gitContext).toBeNull()
    expect(draftSession?.pendingTaskId).toBeNull()
    expect(refreshOptions?.worktreeRequested).toBe(true)

    const draftInput = workspace.tabs[draftTabId].input
    draftInput.text = 'Keep this prompt'
    draftInput.attachments.push({ id: 'attachment-1', type: 'file', name: 'spec.md', path: '/repo/spec.md' })
    draftInput.planRefs.push({
      planId: 'session-1__plan-1',
      sessionId: 'session-1',
      planToolUseId: 'plan-1',
      title: 'Implementation plan',
      status: 'pending',
    })

    const tasklessTabId = await workspace.createDraftTab(undefined, { withoutTask: true })
    const tasklessSession = workspace.sessionFor(tasklessTabId)

    // WHY: a session can intentionally stay outside the task system. That
    // choice must survive dispatch; a missing task id alone means "mint one".
    expect(tasklessSession?.taskCreationDisabled).toBe(true)
    expect(tasklessSession?.pendingTaskId).toBeNull()
    expect(tasklessSession?.workingDirectory).toBe(sourceSession.workingDirectory)
    expect(tasklessSession?.gitContext).toEqual(sourceSession.gitContext)
    // WHY: task/session shortcuts only retarget where the pending prompt will
    // go. They must not clear anything the user already composed.
    expect(workspace.tabs[tasklessTabId].input).toBe(draftInput)
    expect(workspace.tabs[tasklessTabId].input.text).toBe('Keep this prompt')
    expect(workspace.tabs[tasklessTabId].input.attachments).toHaveLength(1)
    expect(workspace.tabs[tasklessTabId].input.planRefs).toHaveLength(1)

    const batchDraftTabId = await workspace.createDraftTab(undefined, { freshTask: true })
    const batchSession = workspace.sessionFor(batchDraftTabId)
    expect(workspace.isFreshTaskDraft(batchDraftTabId)).toBe(true)

    workspace.promptComposer = {
      compose: (prompt: string) => prompt,
      composeImages: () => [],
    }
    workspace.eventReducer = { closeAgentConversationTurn: () => {} }
    workspace.promptTab = () => {}
    workspace.apiFor = () => ({ trackRecentProject: async () => {} })
    batchSession.status = 'idle'

    batchSession.serverId = 'remote-host'
    batchSession.workingDirectory = '~'
    expect(workspace.sendMessage('First batched task', undefined, batchDraftTabId)).toBe(false)
    expect(workspace.draftTabId).toBe(batchDraftTabId)
    expect(registry.tabOrder).not.toContain(batchDraftTabId)

    batchSession.serverId = 'local'
    batchSession.workingDirectory = '/repo'

    expect(workspace.sendMessage('First batched task', undefined, batchDraftTabId)).toBe(true)
    expect(workspace.draftTabId).toBeNull()
    expect(registry.tabOrder).toContain(batchDraftTabId)

    const nextDraftTabId = await workspace.createDraftTab(undefined, { freshTask: true })

    // WHY: Ctrl+Enter dispatches the current task, but the selected surface must
    // remain an empty New Task composer so several independent tasks can be fired.
    expect(registry.activeTabId).toBe(nextDraftTabId)
    expect(workspace.draftTabId).toBe(nextDraftTabId)
    expect(workspace.durableActiveTabId).toBe(batchDraftTabId)
    expect(registry.tabOrder).not.toContain(nextDraftTabId)
    expect(workspace.tabs[nextDraftTabId].input.text).toBe('')

  })
})
