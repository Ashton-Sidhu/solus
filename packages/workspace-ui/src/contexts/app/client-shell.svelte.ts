import { createAppContext } from './create-app-context'
import type { ResourceRoute, ResourceRouteKind } from './resource-routes'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'

/** Client-owned facts. Shared features do not select a layout or read native events. */
export interface ClientShellContext {
  readonly visible: boolean
  readonly workAreaWidth: number
  readonly workAreaHeight: number
  readonly hasInsetTitlebar: boolean
  readonly supportsLocalAttachments: boolean
  readonly supportsNativeSettings: boolean
  readonly hasProjectPanel: boolean
  readonly hasCompanionPanes: boolean
  readonly deferHistoryToolInputs: boolean
  /**
   * Whether this shell has somewhere to send a resource of this kind. The
   * workspace shells open everything in place; the page shell on the account
   * origin has a URL for tasks, works, and sessions and a way to the workspace
   * for the rest; the guest shell (docs/plans/multiplayer-sharing.md §4.2) has
   * only the one resource it was let in to. A surface asks before it offers a
   * Workspace crumb, a chat, or a pull request.
   */
  canOpenResource(kind: ResourceRouteKind): boolean
  /** Open a resource where this shell keeps it: a pane, tab, or page, or a URL. */
  openResource(route: ResourceRoute): void
  /** The workspace this shell opens resources in, once the app core has built it. */
  attachWorkspace(workspace: WorkspaceContext): void
}

export const [getClientShellContext, setClientShellContext] =
  createAppContext<ClientShellContext>('client-shell')
