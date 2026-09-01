import { SvelteSet } from 'svelte/reactivity'
import type { TaskCreationContext } from '../../components/tasks/lib/task-creation-context'
import type { ProjectPageScope } from '../projects/project-catalog'

/**
 * Shell state that isn't a location: whether the pill is expanded, which
 * transient dialogs are up, and which tabs are mid-setup. Everything that used
 * to live here as a page flag or a focus-id mailbox is a route now — see
 * `routing/route-registry.ts`.
 */
export class WorkspaceUiStore {
  isExpanded = $state(false)
  sessionPickerOpen = $state(false)
  taskPickerOpen = $state(false)
  /** The standalone create-task modal: the captured environment it targets. `null` = closed.
   *  Lives here (not in App) so the command palette can open it. */
  taskComposer = $state<TaskCreationContext | null>(null)
  /** The rename prompt: the tab whose session is being named. `null` = closed.
   *  Lives here so every surface's context menu can open the one dialog. */
  sessionRename = $state<{ tabId: string } | null>(null)
  /** The scope owned by Tasks, Pull requests, Workspace, or Automations. Only
   * one page can be open, so one host-qualified value covers the page group. */
  projectPageScope = $state<ProjectPageScope>({ kind: 'all' })
  /** Transient, live-only — which tabs are mid "continue in worktree" setup. */
  readonly continuingWorktreeTabIds = new SvelteSet<string>()

  beginContinueInWorktree(tabId: string): void {
    this.continuingWorktreeTabIds.add(tabId)
  }

  endContinueInWorktree(tabId: string): void {
    this.continuingWorktreeTabIds.delete(tabId)
  }

  isContinuingInWorktree(tabId: string | null | undefined): boolean {
    return !!tabId && this.continuingWorktreeTabIds.has(tabId)
  }
}
