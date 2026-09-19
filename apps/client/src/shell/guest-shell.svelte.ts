import { GUEST_RESOURCE_KINDS } from '@solus/workspace-ui/contexts/app/resource-routes'
import { WebShell } from './web-shell.svelte'

/**
 * The shell a share link opens into (docs/plans/multiplayer-sharing.md §4.2): the
 * browser's composition, with no workspace around the one resource. Surfaces ask
 * `canOpenResource` and offer no Workspace crumb, chat, publishing, sharing, or
 * pane controls, because there is nowhere for those to lead.
 */
export class GuestShell extends WebShell {
  protected override readonly resourceKinds = GUEST_RESOURCE_KINDS
}
