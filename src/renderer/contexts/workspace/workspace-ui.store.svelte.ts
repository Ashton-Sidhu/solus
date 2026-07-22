import type { PageKind, PaneViewStore, SplitOpenOptions } from './pane-view.store.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'

export type SettingsTab = 'general' | 'review' | 'github' | 'api-access' | 'tools' | 'skills' | 'voice' | 'projects' | 'keybindings'

export class WorkspaceUiStore {
  isExpanded = $state(false)
  sessionPickerOpen = $state(false)
  settingsTab = $state<SettingsTab>('general')
  settingsProjectCwd = $state<string | null>(null)
  /** When the automations page opens, an automation id to jump straight into
   *  (the editor view) instead of the list. Cleared by the page once consumed. */
  automationsFocusId = $state<string | null>(null)
  /** The standalone create-task modal: the project it targets. `null` = closed.
   *  Lives here (not in App) so the command palette can open it. */
  taskComposer = $state<{ cwd: string } | null>(null)
  /** When set, the Tasks page opens this task's detail once its list is loaded
   *  (the "Go to task…" palette jump). The page clears it after consuming. */
  tasksFocusId = $state<string | null>(null)
  /** Project the Pull Requests page should show when opened through a targeted
   *  action such as a completed guide-generation toast. The request id makes
   *  repeated navigation to the same project observable while the page is open. */
  prsProjectTarget = $state<{ path: string; requestId: number } | null>(null)
  private prsProjectRequestId = 0

  constructor(
    private panes: PaneViewStore,
    private planStore: PlanStore,
  ) {}

  // ─── Page open state ───
  // The pane store is the source of truth: in editor/web the pages render as
  // pane content. These boolean accessors keep the pre-pane flag API working
  // for pill mode's overlays and the nav/close call sites.

  get plansGalleryOpen(): boolean { return this.panes.isPageOpen('plans-gallery') }
  set plansGalleryOpen(value: boolean) { this.setPage('plans-gallery', value) }
  get settingsOpen(): boolean { return this.panes.isPageOpen('settings') }
  set settingsOpen(value: boolean) { this.setPage('settings', value) }
  get folioGalleryOpen(): boolean { return this.panes.isPageOpen('folio-gallery') }
  set folioGalleryOpen(value: boolean) { this.setPage('folio-gallery', value) }
  get automationsOpen(): boolean { return this.panes.isPageOpen('automations-list') }
  set automationsOpen(value: boolean) { this.setPage('automations-list', value) }
  get tasksOpen(): boolean { return this.panes.isPageOpen('tasks') }
  set tasksOpen(value: boolean) { this.setPage('tasks', value) }
  get prsOpen(): boolean { return this.panes.isPageOpen('prs') }
  set prsOpen(value: boolean) { this.setPage('prs', value) }
  get reviewModeOpen(): boolean { return this.panes.isPageOpen('review-mode') }

  private setPage(kind: PageKind, open: boolean): void {
    if (open) this.panes.openPage(kind)
    else this.panes.closePage(kind)
  }

  /** Open a page and surface it. Mutual exclusion between pages is handled by
   *  `openPage` (it replaces whichever page is open), so this only adds the
   *  pill-mode expansion. */
  private showPage(kind: PageKind): void {
    this.panes.openPage(kind)
    this.isExpanded = true
  }

  private togglePage(kind: PageKind): boolean {
    if (this.panes.isPageOpen(kind)) {
      this.panes.closePage(kind)
      return false
    }
    this.showPage(kind)
    return true
  }

  resetOverlays(opts: { closeArtifact?: boolean } = {}): void {
    this.panes.closePages()
    if (opts.closeArtifact) this.panes.close()
    this.planStore.dismissPreview()
  }

  toggleExpanded(): boolean {
    this.isExpanded = !this.isExpanded
    return this.isExpanded
  }

  showSettings(tab: SettingsTab): void {
    this.settingsProjectCwd = null
    this.settingsTab = tab
    this.sessionPickerOpen = false
    this.showPage('settings')
  }

  showProjectSettings(cwd: string): void {
    this.settingsProjectCwd = cwd
    this.settingsTab = 'projects'
    this.sessionPickerOpen = false
    this.showPage('settings')
  }

  closeSettings(): void {
    this.panes.closePage('settings')
    this.settingsProjectCwd = null
  }

  togglePlansGallery(): boolean {
    return this.togglePage('plans-gallery')
  }

  toggleFolioGallery(): boolean {
    return this.togglePage('folio-gallery')
  }

  toggleAutomations(): boolean {
    return this.togglePage('automations-list')
  }

  toggleTasks(): boolean {
    return this.togglePage('tasks')
  }

  openTasks(): void {
    this.showPage('tasks')
  }

  /** Open the standalone create-task modal for a project. */
  openTaskComposer(cwd: string): void {
    this.taskComposer = { cwd }
  }

  /** Open the Tasks page focused on a specific task (palette "Go to task…"). */
  openTasksToTask(id: string): void {
    this.tasksFocusId = id
    this.openTasks()
  }

  /** Open the automations page, optionally jumping straight to one automation. */
  openAutomations(focusId?: string | null): void {
    this.automationsFocusId = focusId ?? null
    this.showPage('automations-list')
  }

  /** Open a single automation in the side-panel builder (editor mode). Closes any
   *  open page so the pane shows over the conversation; `null` opens a fresh,
   *  not-yet-created automation. */
  openAutomationBuilder(automationId: string | null): void {
    this.panes.closePages()
    this.panes.openAutomation(automationId)
    this.isExpanded = true
  }

  /** Open an automation beside the conversation from an inline chat card.
   *  `moveToSecondary` resets both slots, so any open page closes with it. */
  openAutomationBuilderSecondary(automationId: string, opts: SplitOpenOptions = {}): void {
    this.panes.moveToSecondary({ kind: 'automation', automationId }, opts)
    this.isExpanded = true
  }

  togglePrs(): boolean {
    const opened = this.togglePage('prs')
    if (opened) this.prsProjectTarget = null
    return opened
  }

  openPrs(projectPath: string | null = null): void {
    this.prsProjectTarget = projectPath === null
      ? null
      : { path: projectPath, requestId: ++this.prsProjectRequestId }
    this.showPage('prs')
  }
}
