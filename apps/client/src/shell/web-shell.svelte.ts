import { onDestroy } from 'svelte'
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

/** The browser selects its composition independently of native window modes. */
export class WebShell extends ClientViewport implements ClientShellContext {
  readonly supportsLocalAttachments = false
  readonly supportsNativeSettings = false
  readonly hasInsetTitlebar = document.documentElement.classList.contains('solus-demo')
  /** The kinds this shell opens in place; a narrower shell names fewer. */
  protected readonly resourceKinds: ReadonlySet<ResourceRouteKind> = WORKSPACE_RESOURCE_KINDS
  protected workspace: WorkspaceContext | null = null
  visible = $state(document.visibilityState === 'visible')
  get layout(): 'mobile' | 'wide' { return runtime.isMobileViewport ? 'mobile' : 'wide' }
  /** The workspace surrounds this shell: the project panel and companion panes exist where it is wide. */
  get hasWorkspace(): boolean { return this.resourceKinds.has('workspace') }
  get hasProjectPanel(): boolean { return this.hasWorkspace && this.layout === 'wide' }
  get hasCompanionPanes(): boolean { return this.hasWorkspace && this.layout === 'wide' }
  get deferHistoryToolInputs(): boolean { return this.layout === 'mobile' }
  constructor() {
    super()
    const refreshVisibility = () => { this.visible = document.visibilityState === 'visible' }
    document.addEventListener('visibilitychange', refreshVisibility)
    onDestroy(() => document.removeEventListener('visibilitychange', refreshVisibility))
  }

  attachWorkspace(workspace: WorkspaceContext): void {
    this.workspace = workspace
  }

  canOpenResource(kind: ResourceRouteKind): boolean {
    return this.resourceKinds.has(kind)
  }

  openResource(route: ResourceRoute): void {
    if (!this.workspace || !this.canOpenResource(route.kind)) return
    openResourceInWorkspace(this.workspace, route)
  }
}
