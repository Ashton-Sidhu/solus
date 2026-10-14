import { GUEST_RESOURCE_KINDS, type ResourceRouteKind } from '@solus/workspace-ui/contexts/app/resource-routes'
import { WebShell } from './web-shell.svelte'

/**
 * The shell a share link opens into (docs/plans/host-sharing.md §10): the
 * browser's composition with the real workspace around the one resource. What a
 * guest may do inside it is the host's answer (`host.me.may`), not the shell's;
 * the shell only leaves out the pages a guest cannot read at all.
 */
export class GuestShell extends WebShell {
  protected override readonly resourceKinds: ReadonlySet<ResourceRouteKind>

  /** A shared work opens alone in its pane: no workspace surrounds it, so there is no pane to close into. */
  constructor(sharedKind: 'work' | 'session') {
    super()
    this.resourceKinds = sharedKind === 'work' ? new Set<ResourceRouteKind>(['work']) : GUEST_RESOURCE_KINDS
  }
}
