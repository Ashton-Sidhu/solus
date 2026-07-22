// Frame-level chrome shared between WorkspaceBody and the full-page sub-views
// (Folio, Plans, Settings) that host the "expand" affordances inline in their
// own headers. This is a one-way published projection written ONLY by
// WorkspaceBody's mirror effect; settings owns the persisted project-panel
// flag. Readers (FrameExpandButton and page headers) must never write it.
class FrameChromeStore {
  sidebarOpen = $state(true)
  projectPanelOpen = $state(false)
  expandSidebar = $state<(() => void) | null>(null)
  expandProjectPanel = $state<(() => void) | null>(null)
}

export const frameChrome = new FrameChromeStore()
