import { loadPickerResultType, savePickerResultType, type PickerResultType } from '../../components/session/unified-picker/lib/picker-preferences'
import { SvelteSet } from 'svelte/reactivity'
import type { PickerScope } from '../../components/session/unified-picker/lib/picker-scope'
import type { PickerSearchMode, PickerSort } from '../../components/session/unified-picker/lib/picker-search'
import type { TaskCreationContext } from '../../components/tasks/lib/task-creation-context'
import type { ProjectPageScope } from '../projects/project-catalog'
import { loadProjectPageScope, saveProjectPageScope } from '../projects/page-scope-preference'

/**
 * Shell state that is not a location: which transient dialogs are open and
 * which tabs are in setup. Everything that used
 * to live here as a page flag or a focus-id mailbox is a route now — see
 * `routing/route-registry.ts`.
 */
export class WorkspaceUiStore {
  /** The one picker over tasks and their sessions. Tasks and sessions were two
   *  overlays with two flags until they became one list; a caller that used to
   *  want "the session picker" or "the task picker" wants this. */
  unifiedPickerOpen = $state(false)
  /** What project that picker is scoped to. Lives here, not in the component,
   *  because the picker is mounted separately per layout and per surface. */
  pickerScope = $state<PickerScope>({ kind: 'current' })
  /** How that picker orders a query's hits, and what it matches them against.
   *  Held with the scope for the same reason: one picker, many mounts. */
  pickerSort = $state<PickerSort>('relevance')
  pickerSearchMode = $state<PickerSearchMode>('full-text')
  private resultType = $state(loadPickerResultType())

  get pickerResultType(): PickerResultType { return this.resultType }

  set pickerResultType(value: PickerResultType) {
    this.resultType = value
    savePickerResultType(value)
  }

  /** The standalone create-task modal: the captured environment it targets. `null` = closed.
   *  Lives here (not in App) so the command palette can open it. */
  taskComposer = $state<TaskCreationContext | null>(null)
  /** The rename prompt: the tab whose session is being named. `null` = closed.
   *  Lives here so every surface's context menu can open the one dialog. */
  sessionRename = $state<{ tabId: string } | null>(null)
  /** The scope owned by Tasks, Pull requests, Workspace, or Automations. Only
   * one page can be open, so one value covers the page group; it survives a
   * reload on this device. */
  private pageScope = $state<ProjectPageScope>(loadProjectPageScope())

  get projectPageScope(): ProjectPageScope { return this.pageScope }

  set projectPageScope(scope: ProjectPageScope) {
    this.pageScope = scope
    saveProjectPageScope(scope)
  }
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
