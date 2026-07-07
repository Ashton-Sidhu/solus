import type { PageKind, PaneViewStore, SplitOpenOptions } from './pane-view.store.svelte'
import type { PlanStore } from './plan.store.svelte'

export type SettingsTab = 'general' | 'review' | 'api-access' | 'tools' | 'skills' | 'voice' | 'projects' | 'keybindings'

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

  constructor(
    private artifactViewer: PaneViewStore,
    private planStore: PlanStore,
  ) {}

  // ─── Page open state ───
  // The pane store is the source of truth: in editor/web the pages render as
  // pane content. These boolean accessors keep the pre-pane flag API working
  // for pill mode's overlays and the nav/close call sites.

  get plansGalleryOpen(): boolean { return this.artifactViewer.isPageOpen('plans-gallery') }
  set plansGalleryOpen(value: boolean) { this.setPage('plans-gallery', value) }
  get settingsOpen(): boolean { return this.artifactViewer.isPageOpen('settings') }
  set settingsOpen(value: boolean) { this.setPage('settings', value) }
  get folioGalleryOpen(): boolean { return this.artifactViewer.isPageOpen('folio-gallery') }
  set folioGalleryOpen(value: boolean) { this.setPage('folio-gallery', value) }
  get automationsOpen(): boolean { return this.artifactViewer.isPageOpen('automations-list') }
  set automationsOpen(value: boolean) { this.setPage('automations-list', value) }
  get tasksOpen(): boolean { return this.artifactViewer.isPageOpen('tasks') }
  set tasksOpen(value: boolean) { this.setPage('tasks', value) }
  get prsOpen(): boolean { return this.artifactViewer.isPageOpen('prs') }
  set prsOpen(value: boolean) { this.setPage('prs', value) }

  private setPage(kind: PageKind, open: boolean): void {
    if (open) this.artifactViewer.openPage(kind)
    else this.artifactViewer.closePage(kind)
  }

  /** Open a page and surface it. Mutual exclusion between pages is handled by
   *  `openPage` (it replaces whichever page is open), so this only adds the
   *  pill-mode expansion. */
  private showPage(kind: PageKind): void {
    this.artifactViewer.openPage(kind)
    this.isExpanded = true
  }

  private togglePage(kind: PageKind): boolean {
    if (this.artifactViewer.isPageOpen(kind)) {
      this.artifactViewer.closePage(kind)
      return false
    }
    this.showPage(kind)
    return true
  }

  resetOverlays(opts: { closeArtifactViewer?: boolean } = {}): void {
    this.artifactViewer.closePages()
    if (opts.closeArtifactViewer) this.artifactViewer.close()
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
    this.artifactViewer.closePage('settings')
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
    this.artifactViewer.closePages()
    this.artifactViewer.openAutomation(automationId)
    this.isExpanded = true
  }

  /** Open an automation beside the conversation from an inline chat card.
   *  `moveToSecondary` resets both slots, so any open page closes with it. */
  openAutomationBuilderSecondary(automationId: string, opts: SplitOpenOptions = {}): void {
    this.artifactViewer.moveToSecondary({ kind: 'automation', automationId }, opts)
    this.isExpanded = true
  }

  togglePrs(): boolean {
    return this.togglePage('prs')
  }

  openPrs(): void {
    this.showPage('prs')
  }
}
