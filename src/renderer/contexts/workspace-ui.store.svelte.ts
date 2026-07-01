import type { PaneViewStore, SplitOpenOptions } from './pane-view.store.svelte'
import type { PlanStore } from './plan.store.svelte'

export type SettingsTab = 'general' | 'review' | 'api-access' | 'git-providers' | 'tools' | 'skills' | 'voice' | 'projects' | 'keybindings'

export class WorkspaceUiStore {
  isExpanded = $state(false)
  plansGalleryOpen = $state(false)
  sessionPickerOpen = $state(false)
  settingsOpen = $state(false)
  settingsTab = $state<SettingsTab>('general')
  settingsProjectCwd = $state<string | null>(null)
  folioGalleryOpen = $state(false)
  automationsOpen = $state(false)
  tasksOpen = $state(false)
  prsOpen = $state(false)
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

  resetOverlays(opts: { closeArtifactViewer?: boolean } = {}): void {
    this.plansGalleryOpen = false
    this.folioGalleryOpen = false
    this.automationsOpen = false
    this.tasksOpen = false
    this.prsOpen = false
    this.settingsOpen = false
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
    this.settingsOpen = true
    this.plansGalleryOpen = false
    this.sessionPickerOpen = false
    this.tasksOpen = false
    this.prsOpen = false
    this.isExpanded = true
  }

  showProjectSettings(cwd: string): void {
    this.settingsProjectCwd = cwd
    this.settingsTab = 'projects'
    this.settingsOpen = true
    this.plansGalleryOpen = false
    this.sessionPickerOpen = false
    this.tasksOpen = false
    this.prsOpen = false
    this.isExpanded = true
  }

  closeSettings(): void {
    this.settingsOpen = false
    this.settingsProjectCwd = null
  }

  togglePlansGallery(): boolean {
    this.plansGalleryOpen = !this.plansGalleryOpen
    if (this.plansGalleryOpen) {
      this.settingsOpen = false
      this.folioGalleryOpen = false
      this.automationsOpen = false
      this.tasksOpen = false
      this.prsOpen = false
      this.isExpanded = true
    }
    return this.plansGalleryOpen
  }

  toggleFolioGallery(): boolean {
    this.folioGalleryOpen = !this.folioGalleryOpen
    if (this.folioGalleryOpen) {
      this.settingsOpen = false
      this.plansGalleryOpen = false
      this.automationsOpen = false
      this.tasksOpen = false
      this.prsOpen = false
      this.isExpanded = true
    }
    return this.folioGalleryOpen
  }

  toggleAutomations(): boolean {
    this.automationsOpen = !this.automationsOpen
    if (this.automationsOpen) {
      this.settingsOpen = false
      this.plansGalleryOpen = false
      this.folioGalleryOpen = false
      this.tasksOpen = false
      this.prsOpen = false
      this.isExpanded = true
    }
    return this.automationsOpen
  }

  toggleTasks(): boolean {
    this.tasksOpen = !this.tasksOpen
    if (this.tasksOpen) {
      this.settingsOpen = false
      this.plansGalleryOpen = false
      this.folioGalleryOpen = false
      this.automationsOpen = false
      this.prsOpen = false
      this.isExpanded = true
    }
    return this.tasksOpen
  }

  openTasks(): void {
    this.settingsOpen = false
    this.plansGalleryOpen = false
    this.folioGalleryOpen = false
    this.automationsOpen = false
    this.prsOpen = false
    this.tasksOpen = true
    this.isExpanded = true
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
    this.settingsOpen = false
    this.plansGalleryOpen = false
    this.folioGalleryOpen = false
    this.tasksOpen = false
    this.prsOpen = false
    this.automationsOpen = true
    this.isExpanded = true
  }

  /** Open a single automation in the side-panel builder (editor mode). Closes the
   *  full-page list overlay so the pane shows over the conversation; `null` opens
   *  a fresh, not-yet-created automation. */
  openAutomationBuilder(automationId: string | null): void {
    this.automationsOpen = false
    this.settingsOpen = false
    this.plansGalleryOpen = false
    this.folioGalleryOpen = false
    this.artifactViewer.openAutomation(automationId)
    this.isExpanded = true
  }

  /** Open an automation beside the conversation from an inline chat card. */
  openAutomationBuilderSecondary(automationId: string, opts: SplitOpenOptions = {}): void {
    this.automationsOpen = false
    this.settingsOpen = false
    this.plansGalleryOpen = false
    this.folioGalleryOpen = false
    this.artifactViewer.moveToSecondary({ kind: 'automation', automationId }, opts)
    this.isExpanded = true
  }

  togglePrs(): boolean {
    this.prsOpen = !this.prsOpen
    if (this.prsOpen) {
      this.settingsOpen = false
      this.plansGalleryOpen = false
      this.folioGalleryOpen = false
      this.automationsOpen = false
      this.tasksOpen = false
      this.isExpanded = true
    }
    return this.prsOpen
  }

  openPrs(): void {
    this.settingsOpen = false
    this.plansGalleryOpen = false
    this.folioGalleryOpen = false
    this.automationsOpen = false
    this.tasksOpen = false
    this.prsOpen = true
    this.isExpanded = true
  }
}
