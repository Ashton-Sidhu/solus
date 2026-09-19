import { onDestroy } from 'svelte'
import { localApi } from '@solus/client-core/local-api'
import type { ClientShellContext } from '@solus/workspace-ui/contexts/app/client-shell.svelte'
import { ClientViewport } from '@solus/workspace-ui/contexts/app/client-viewport.svelte'
import { runtime } from '@solus/workspace-ui/contexts/app/runtime.svelte'
import {
  openResourceInWorkspace,
  WORKSPACE_RESOURCE_KINDS,
  type ResourceRoute,
  type ResourceRouteKind,
} from '@solus/workspace-ui/contexts/app/resource-routes'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'

/** Desktop facts for the single native workspace window. */
export class DesktopWindow extends ClientViewport implements ClientShellContext {
  readonly platform = localApi.getPlatform()
  visible = $state(true)
  readonly supportsLocalAttachments = true
  readonly supportsNativeSettings = true
  readonly hasInsetTitlebar = this.platform === 'darwin'
  readonly hasProjectPanel = true
  readonly hasCompanionPanes = true
  private workspace: WorkspaceContext | null = null
  get deferHistoryToolInputs(): boolean { return runtime.isMobileViewport }

  constructor() {
    super()
    if (this.hasInsetTitlebar) document.documentElement.classList.add('is-mac-workspace')
    const shown = window.solusNative?.onWindowShown(() => { this.visible = true })
    const hidden = window.solusNative?.onWindowHidden(() => { this.visible = false })
    onDestroy(() => { shown?.(); hidden?.() })
  }

  attachWorkspace(workspace: WorkspaceContext): void {
    this.workspace = workspace
  }

  canOpenResource(kind: ResourceRouteKind): boolean {
    return WORKSPACE_RESOURCE_KINDS.has(kind)
  }

  openResource(route: ResourceRoute): void {
    if (this.workspace) openResourceInWorkspace(this.workspace, route)
  }
}
