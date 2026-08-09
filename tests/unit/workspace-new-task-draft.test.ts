import { afterEach, describe, expect, test } from 'bun:test'
import { SvelteMap } from 'svelte/reactivity'
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

const GLOBAL_MODEL_CONFIG = {
  modelId: 'claude-sonnet-4-5',
  reasoningEffort: 'high' as const,
  contextWindow: null,
  fastMode: false,
}

/**
 * A workspace holding one started session, wired with just enough of the real
 * context to open drafts and dispatch them.
 */
async function makeWorkspace(options: { runtimeTabCreations?: { count: number } } = {}) {
  installRendererGlobals()
  const runtime = options.runtimeTabCreations ?? { count: 0 }
  Object.assign(window.solus, {
    createTab: async (tabId: string) => {
      runtime.count++
      return { tabId }
    },
    prompt: async () => {},
    trackRecentProject: async () => {},
  })

  const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
  const sourceSession = {
    id: 'source-session',
    agentSessionId: 'agent-session',
    status: 'idle',
    messages: [],
    run: {
      serverId: 'local',
      provider: 'codex',
      workingDirectory: '/repo',
      gitContext: { repoRoot: '/repo', branch: 'feature/tasks', targetBranch: 'main' },
      worktree: null,
      taskServerId: 'local',
      permissionMode: 'auto',
      modelConfig: { modelId: 'gpt-5', reasoningEffort: 'high', contextWindow: null, fastMode: false },
      sessionSkills: [],
      pendingHostDispatch: null,
    } as Session['run'],
  } as unknown as Session
  const sourceTab = { id: 'source-tab', sessionId: sourceSession.id } as Tab
  const registry = {
    tabs: { [sourceTab.id]: sourceTab } as Record<string, Tab>,
    sessions: { [sourceSession.id]: sourceSession } as Record<string, Session>,
    tabOrder: [sourceTab.id],
    activeTabId: sourceTab.id,
    get activeSession() { return this.sessions[this.tabs[this.activeTabId]?.sessionId] },
    sessionFor(tabId: string) { return this.sessions[this.tabs[tabId]?.sessionId] },
  }

  const navigations: Array<{ name: string; draftId?: string }> = []
  const workspace = Object.create(WorkspaceContext.prototype) as any
  workspace.registry = registry
  workspace.sessionDrafts = new SvelteMap()
  workspace.router = {
    asidePanes: [],
    chatSessionIn: () => null, showsChat: () => false,
    focusedPaneId: 'pane_1',
    pane: () => null,
    navigate: (ref: any) => navigations.push({ name: ref.name, draftId: ref.params?.draftId }),
  }
  workspace.lifecycle = {
    staticInfo: { projectPath: '/repo', workspacePath: '/repo' },
    pluginCommands: { global: [], project: [] },
  }
  workspace.ui = { isExpanded: true }
  workspace.settings = { activeAgent: 'claude-code', rateLimitBehavior: 'ask', worktreeEnabled: true }
  workspace.config = {
    globalDefaults: {
      permissionMode: 'auto',
      workingDirectory: '/repo',
      gitContext: null,
      worktreeBaseBranch: null,
      modelConfig: GLOBAL_MODEL_CONFIG,
    },
    defaultReasoningEffortFor: () => 'high',
    pendingSessionStartTarget: () => null,
  }
  workspace.tasksStore = {
    taskForSession: () => ({ id: 'task-root' }),
    tasks: [{ id: 'task-root' }],
  }
  workspace.promptComposer = { compose: (prompt: string) => prompt, composeImages: () => [] }
  workspace.eventReducer = { closeAgentConversationTurn: () => {} }
  workspace.environment = { refreshEnvironment: async () => {} }
  workspace.refreshPluginCommands = async () => {}
  workspace.resetOverlays = () => {}
  workspace.handleError = () => {}
  workspace.ctxFor = () => ({})
  workspace.apiFor = () => ({ trackRecentProject: async () => {} })
  workspace.promptTab = () => {}
  workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
  workspace.addTabToOrder = (tabId: string) => {
    if (!registry.tabOrder.includes(tabId)) registry.tabOrder.push(tabId)
  }

  return { workspace, registry, sourceSession, runtime, navigations }
}

describe('session drafts', () => {
  test('exists only as a draft until the prompt is sent', async () => {
    const { workspace, registry, runtime, navigations } = await makeWorkspace()

    const draft = workspace.openSessionDraft({ via: 'keybinding' })

    // WHY: a draft is not a tab in any state. Nothing lists it — the strip and
    // the sidebar both project `tabOrder` — and nothing reaches the server for
    // a prompt the user may never send.
    expect(registry.tabOrder).toEqual(['source-tab'])
    expect(workspace.sessionDrafts.get(draft.id)).toBe(draft)
    expect(runtime.count).toBe(0)
    expect(navigations.at(-1)).toEqual({ name: 'draft', draftId: draft.id })

    // WHY: it inherits the task it was opened from, so a session started from
    // inside a task is more of that task by default.
    expect(draft.task).toEqual({ kind: 'existing', taskId: 'task-root' })

    draft.prompt.text = 'Implement it'
    const tabId = workspace.startSessionDraft(draft.id)

    // WHY: sending is the moment the draft stops being one. There is only ever
    // one of the two, so the draft is dropped as the tab appears.
    expect(tabId).toBeTruthy()
    expect(workspace.sessionDrafts.has(draft.id)).toBe(false)
    expect(registry.tabOrder).toEqual(['source-tab', tabId])

    // WHY: everything the draft settled carries into the session it becomes —
    // the prompt *and* where it files. Losing the task here would silently file
    // the session under a new one the user never asked for.
    const started = workspace.sessionFor(tabId)
    expect(started.prompt.text).toBe('Implement it')
    expect(started.task).toEqual({ kind: 'existing', taskId: 'task-root' })
  })

  test('a fresh task takes the app defaults, not the current session tuning', async () => {
    const { workspace, sourceSession } = await makeWorkspace()

    const { startsWorktree } = await import('../../src/renderer/contexts/workspace/run-config')
    const fresh = workspace.openSessionDraft({ freshTask: true })

    // WHY: "new task" means new work on the project, so it starts from the
    // app's own defaults and the repo root — not from the model, agent or
    // checkout the conversation on screen happens to be tuned to.
    expect(fresh.run.provider).toBe('claude-code')
    expect(fresh.run.modelConfig.modelId).toBe(GLOBAL_MODEL_CONFIG.modelId)
    expect(fresh.run.sessionSkills).toEqual([])
    expect(fresh.run.workingDirectory).toBe('/repo')
    expect(fresh.run.gitContext).toBeNull()
    expect(fresh.task).toEqual({ kind: 'new' })
    // WHY: the saved worktree default decides where the next session starts;
    // a per-session toggle must not leak into it.
    expect(startsWorktree(fresh.run)).toBe(true)
    // WHY: nothing dispatched, so the run owns its own tasks. A split between
    // the two ids is what marks a dispatch, and inventing one here would file
    // this session's task on a host it never ran on.
    expect(fresh.run.taskServerId).toBe(fresh.run.serverId)

    // The source session is untouched by any of it.
    expect(sourceSession.run.provider).toBe('codex')
    expect(sourceSession.run.gitContext?.branch).toBe('feature/tasks')
  })

  test('a fresh task stays on the host the current session runs on', async () => {
    const { workspace, sourceSession } = await makeWorkspace()
    // The session on screen was dispatched to another machine, so its project
    // root is a path that only exists there.
    sourceSession.run.serverId = 'studio'

    const { startsWorktree } = await import('../../src/renderer/contexts/workspace/run-config')
    const fresh = workspace.openSessionDraft({ freshTask: true })

    // WHY: "new task" is new work on the *same project*, which lives on that
    // host. Falling back to the local default would aim a remote path at this
    // machine and start the session in a directory that is not there.
    expect(fresh.run.serverId).toBe('studio')
    expect(fresh.run.workingDirectory).toBe('/repo')
  })

  test('changing the task destination keeps what was already composed', async () => {
    const { workspace } = await makeWorkspace()

    const draft = workspace.openSessionDraft({ freshTask: true })
    draft.prompt.text = 'Keep this prompt'
    draft.prompt.attachments.push({
      id: 'attachment-1', type: 'file', name: 'spec.md', path: '/repo/spec.md',
    } as never)

    // WHY: the ⌥ shortcuts only say where the prompt will go. Pointing the same
    // draft somewhere else must not discard the text, attachments or references
    // the user has already written — which is why a draft is mutated in place
    // rather than discarded and rebuilt.
    draft.task = { kind: 'none' }

    expect(draft.prompt.text).toBe('Keep this prompt')
    expect(draft.prompt.attachments).toHaveLength(1)
    // WHY: staying outside the task system is a choice, not an absence. The
    // union says so structurally, where a missing id alone would read as
    // "mint one" and silently overrule the user.
    expect(draft.task).toEqual({ kind: 'none' })
  })

  test('a send the renderer refuses leaves the draft intact', async () => {
    const { workspace } = await makeWorkspace()

    const draft = workspace.openSessionDraft({ freshTask: true })
    draft.prompt.text = 'First batched task'
    const tabId = workspace.startSessionDraft(draft.id)
    const session = workspace.sessionFor(tabId)

    // A remote host with no directory on it cannot start anything.
    session.run.serverId = 'remote-host'
    session.run.workingDirectory = '~'
    session.status = 'idle'

    // WHY: a send that never left the renderer must not read as a started
    // session — nothing was dispatched, so nothing has begun.
    expect(workspace.sendMessage('First batched task', undefined, tabId)).toBe(false)
    expect(session.agentSessionId).toBeNull()

    session.run.serverId = 'local'
    session.run.workingDirectory = '/repo'
    expect(workspace.sendMessage('First batched task', undefined, tabId)).toBe(true)
  })

  test('survives a reload with its prompt and target intact', async () => {
    const { workspace } = await makeWorkspace()

    const draft = workspace.openSessionDraft({ freshTask: true })
    draft.prompt.text = 'Half-written thought'
    draft.task = { kind: 'existing', taskId: 'task-root' }

    const snapshot = JSON.parse(JSON.stringify(workspace.sessionDraftsSnapshot))

    // A second workspace stands in for the next launch.
    const next = await makeWorkspace()
    next.workspace.restoreSessionDrafts(snapshot)
    const restored = next.workspace.sessionDrafts.get(draft.id)

    // WHY: a draft is the only place an unsent prompt lives — it has no tab and
    // no session to fall back on — so losing it on reload loses the user's
    // writing outright. The id is kept so the saved `draft/<id>` route still
    // resolves to the draft it names.
    expect(restored).toBeTruthy()
    expect(restored.id).toBe(draft.id)
    expect(restored.prompt.text).toBe('Half-written thought')
    expect(restored.task).toEqual({ kind: 'existing', taskId: 'task-root' })
    expect(restored.run.workingDirectory).toBe(draft.run.workingDirectory)
  })

  test('two views of one conversation share the unsent message', async () => {
    const { workspace, registry } = await makeWorkspace()

    const draft = workspace.openSessionDraft({ freshTask: true })
    draft.prompt.text = 'Half a thought'
    const tabId = workspace.startSessionDraft(draft.id)

    // The same conversation pinned into a second view — a split chat, or the
    // same session reached from the picker.
    const mirrorTabId = 'mirror-tab'
    registry.tabs[mirrorTabId] = {
      id: mirrorTabId,
      sessionId: registry.tabs[tabId].sessionId,
    } as never

    // WHY: the unsent message is addressed *to* the session, so both views show
    // the one thing you are about to say to it. Held per tab, they would be two
    // drafts of which only one could ever be sent, and the other silently lost.
    expect(workspace.inputFor(mirrorTabId)).toBe(workspace.inputFor(tabId))
    workspace.inputFor(mirrorTabId).text = 'Finished thought'
    expect(workspace.inputFor(tabId).text).toBe('Finished thought')
  })

  test('dispatching one draft leaves the next one empty', async () => {
    const { workspace, registry } = await makeWorkspace()

    const first = workspace.openSessionDraft({ freshTask: true })
    first.prompt.text = 'First batched task'
    const firstTabId = workspace.startSessionDraft(first.id)

    const next = workspace.openSessionDraft({ freshTask: true })

    // WHY: ⌃↵ fires the current task and leaves an empty composer, so several
    // independent tasks can be sent in a row. The dispatched one keeps its place
    // in the strip beside it.
    expect(next.prompt.text).toBe('')
    expect(workspace.sessionDrafts.has(next.id)).toBe(true)
    expect(registry.tabOrder).toContain(firstTabId)
    expect(workspace.sessionFor(firstTabId).prompt.text).toBe('First batched task')
  })
})
