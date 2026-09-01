/**
 * Curated renderer context surface.
 * If it isn't exported here, it's an internal organ — import it only from within its folder.
 */

/** Core workspace access; the gateway to session.tasksStore/prsStore/worksStore/automationsStore/stacksStore/router. */
export { getWorkspaceContext, setWorkspaceContext } from './workspace/workspace.context.svelte'

/** Where the workspace is. `routing/` internals stay private organs — surfaces
 *  reach the live location through `getWorkspaceContext().router`. */
export { parseRoute, serializeRoute } from './workspace/routing/codec'
export type { RouteName, RouteRef, SettingsTab } from './workspace/routing/route-registry'
export type { Location, PaneEntry, PaneId } from './workspace/routing/location'

/** App-wide settings, window, agent, status, voice, runtime, and tool state. */
export { getSettingsContext } from './app/settings.context.svelte'
export { getWindowContext } from './app/window.context.svelte'
export { getAgentContext } from './app/agent.context.svelte'
export { getStatusBarContext } from './app/status-bar.context.svelte'
export { getVoiceModelStore } from './app/voice-model.store.svelte'
export { runtime } from './app/runtime.svelte'
export { toolsStore } from './app/tools.store.svelte'

/** Git state for the active session environment. */
export { getSessionEnvironmentStore, environmentBranchKey } from './git/session-environment.store.svelte'

/** Plan state and operations exposed to renderer surfaces. */
export { getPlanStore } from './plans/plan.store.svelte'

/** Global local-first task state shared by task and session surfaces. */
export { TasksStore } from './tasks/tasks.store.svelte'

/** Known projects and per-project configuration. */
export { projectsStore } from './projects/projects.store.svelte'
export { getProjectConfigStore } from './projects/project-config.store.svelte'

/** Composer drafts parked for later, scoped per project. */
export { savedPrompts } from './saved-prompts/saved-prompts.store.svelte'

/** Connection, authentication, and server-selection state. */
export { connectionsStore } from './connections/connections.store.svelte'
export { serversStore } from './connections/servers.store.svelte'
export { hostCapabilitiesStore } from './connections/host-capabilities.store.svelte'
export {
  compareNearbyHosts,
  discoveredServerUrl,
  filterUnsavedDiscoveredServers,
  mergeNearbyHosts,
  NEARBY_HOST_TTL_MS,
  unannouncedDiscoveredServers,
} from './connections/discovery'
export {
  hostAffinityGlyph,
  hostStatusDotClass,
  hostStatusLabel,
} from './connections/host-affinity'

/** Cloudflare deployment profile: status, connect/disconnect, connect requests. */
export {
  cloudflareStore,
  CLOUDFLARE_SIGNUP_URL,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  CLOUDFLARE_TOKEN_URL,
} from './cloudflare/cloudflare.store.svelte'

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
export type {
  CloudflareAccountOption,
  CloudflareConnectFailure,
  CloudflareStatus,
} from './cloudflare/cloudflare.store.svelte'
export type { DiscoveryFilterInput, NearbyHost } from './connections/discovery'
export type { HostAffinityGlyph, HostAffinityTarget } from './connections/host-affinity'
export type { ServerItem, ServerItemStatus, UnknownRemoteHost } from './connections/servers.store.svelte'
