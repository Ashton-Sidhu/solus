import { GUEST_RESOURCE_KINDS } from '@solus/workspace-ui/contexts/app/resource-routes'
import { WebShell } from './web-shell.svelte'

/**
 * The shell a share link opens into (docs/plans/host-sharing.md §10): the
 * browser's composition with the real workspace around the one resource. What a
 * guest may do inside it is the host's answer (`host.me.may`), not the shell's;
 * the shell only leaves out the pages a guest cannot read at all.
 */
export class GuestShell extends WebShell {
  protected override readonly resourceKinds = GUEST_RESOURCE_KINDS
}
