/**
 * Curated renderer context surface.
 * If it isn't exported here, it's an internal organ — import it only from within its folder.
 */

/** Core workspace access; the gateway to session.tasksStore/prsStore/worksStore/automationsStore/stacksStore/panes. */
export { getWorkspaceContext, setWorkspaceContext } from './workspace/workspace.context.svelte'

/** App-wide settings, window, agent, status, voice, toast, runtime, and tool state. */
export { getSettingsContext } from './app/settings.context.svelte'
export { getWindowContext } from './app/window.context.svelte'
export { getAgentContext } from './app/agent.context.svelte'
export { getStatusBarContext } from './app/status-bar.context.svelte'
export { getVoiceModelStore } from './app/voice-model.store.svelte'
export { toasts } from './app/toast.store.svelte'
export { runtime } from './app/runtime.svelte'
export { toolsStore } from './app/tools.store.svelte'

/** Git state for the active session environment. */
export { getSessionEnvironmentStore } from './git/session-environment.store.svelte'

/** Plan state and operations exposed to renderer surfaces. */
export { getPlanStore } from './plans/plan.store.svelte'

/** Run process state and run dock presentation state. */
export { getRunStore } from './run/run.store.svelte'
export { getRunDockStore } from './run/run-dock.store.svelte'

/** Known projects and per-project configuration. */
export { projectsStore } from './projects/projects.store.svelte'
export { getProjectConfigStore } from './projects/project-config.store.svelte'

/** Connection, authentication, and server-selection state. */
export { connectionsStore } from './connections/connections.store.svelte'
export { serversStore } from './connections/servers.store.svelte'

/** Session sidebar navigation and historical-session loading. */
export { getSessionSidebarStore } from './workspace/session-sidebar.store.svelte'
export { createSessionHistoryStore } from './workspace/session-history.store.svelte'

/** Public types consumed outside the contexts feature. */
export type { WorkspaceContext } from './workspace/workspace.context.svelte'
export type {
  ProjectPanelSectionId,
  SettingsContext,
  TabGroupMode,
} from './app/settings.context.svelte'
export type { WindowContext } from './app/window.context.svelte'
export type { AgentContext } from './app/agent.context.svelte'
export type { SessionEnvironmentStore } from './git/session-environment.store.svelte'
export type { PlanStore } from './plans/plan.store.svelte'
export type { ConnectionEndpoint } from './connections/connections.store.svelte'
export type { ServerItem, ServerItemStatus } from './connections/servers.store.svelte'
