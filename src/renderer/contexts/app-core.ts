import { SettingsContext, setSettingsContext } from './settings.context.svelte'
import { WorkspaceContext, setWorkspaceContext } from './workspace.context.svelte'
import { WindowContext, setWindowContext } from './window.context.svelte'
import { StatusBarContext, setStatusBarContext } from './status-bar.context.svelte'
import { PlanStore, setPlanStore } from './plan.store.svelte'
import { GitStatusStore, setGitStatusStore } from './git-status.store.svelte'
import { RunStore, setRunStore } from './run.store.svelte'
import { RunDockStore, setRunDockStore } from './run-dock.store.svelte'
import { ProjectConfigStore, setProjectConfigStore } from './project-config.store.svelte'
import { AgentContext, setAgentContext } from './agent.context.svelte'
import { SessionSidebarStore, setSessionSidebarStore } from './session-sidebar.store.svelte'
import { KeybindingsContext, setKeybindingsContext } from '../lib/keybindings/dispatcher.svelte'

export interface AppCore {
  settings: SettingsContext
  windowCtx: WindowContext
  statusBar: StatusBarContext
  planStore: PlanStore
  gitStatusStore: GitStatusStore
  runStore: RunStore
  runDockStore: RunDockStore
  projectConfigStore: ProjectConfigStore
  sessionSidebarStore: SessionSidebarStore
  session: WorkspaceContext
  agent: AgentContext
  keybindings: KeybindingsContext
}

/**
 * Constructs every shared context/store, registers them on the Svelte context,
 * and wires the cross-store bindings. The single source of truth shared by the
 * Electron renderer (`src/renderer/App.svelte`) and the web client
 * (`client/src/App.svelte`) so a new store added here lands in both shells.
 *
 * Platform-specific setup (analytics, root scaling, design mode, click-through,
 * view modes) stays in each App.svelte — only what's identical lives here.
 */
export function createAppCore(): AppCore {
  const settings = new SettingsContext()
  const windowCtx = new WindowContext()
  const statusBar = new StatusBarContext(settings)
  const planStore = new PlanStore()
  const gitStatusStore = new GitStatusStore()
  const runStore = new RunStore()
  const runDockStore = new RunDockStore()
  const projectConfigStore = new ProjectConfigStore()
  const agent = new AgentContext(settings)
  const session = new WorkspaceContext(settings, windowCtx, statusBar, planStore, gitStatusStore, agent)
  const sessionSidebarStore = new SessionSidebarStore(settings, session, planStore)
  statusBar.bind(session)
  statusBar.bindAgent(agent)

  const keybindings = new KeybindingsContext()
  keybindings.setOverrides(settings.keybindings)

  setSettingsContext(settings)
  setWindowContext(windowCtx)
  setStatusBarContext(statusBar)
  setWorkspaceContext(session)
  setPlanStore(planStore)
  setGitStatusStore(gitStatusStore)
  setRunStore(runStore)
  setRunDockStore(runDockStore)
  setProjectConfigStore(projectConfigStore)
  setSessionSidebarStore(sessionSidebarStore)
  setAgentContext(agent)
  setKeybindingsContext(keybindings)

  return {
    settings,
    windowCtx,
    statusBar,
    planStore,
    gitStatusStore,
    runStore,
    runDockStore,
    projectConfigStore,
    sessionSidebarStore,
    session,
    agent,
    keybindings,
  }
}
