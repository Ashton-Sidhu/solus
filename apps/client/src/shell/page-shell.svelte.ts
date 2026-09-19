import type { ResourceRoute, ResourceRouteKind } from '@solus/workspace-ui/contexts/app/resource-routes'
import { pageRouteForResource, pageRouteFragment } from '../lib/page-routes'
import { WebShell } from './web-shell.svelte'

/**
 * The shell of one organization's pages on the account origin
 * (docs/plans/cloud-service-model.md): tasks, works, and session records against
 * the workspace service, with no panes, no project panel, and no chat. A task, a
 * work, or a session opens by changing the URL; "workspace" leaves for the
 * workspace bundle at the base path; anything else has nowhere to go here.
 */
export class PageShell extends WebShell {
  protected override readonly resourceKinds: ReadonlySet<ResourceRouteKind> = new Set<ResourceRouteKind>([
    'workspace', 'task', 'work', 'session',
  ])
  override get hasProjectPanel(): boolean { return false }
  override get hasCompanionPanes(): boolean { return false }

  constructor(
    readonly organizationId: string,
    /** Where the workspace bundle is mounted, e.g. `/app/`. */
    private readonly workspaceUrl: string,
  ) {
    super()
  }

  override openResource(route: ResourceRoute): void {
    if (route.kind === 'workspace') {
      window.location.assign(this.workspaceUrl)
      return
    }
    const page = pageRouteForResource(this.organizationId, route)
    if (page) window.location.hash = pageRouteFragment(page)
  }
}
