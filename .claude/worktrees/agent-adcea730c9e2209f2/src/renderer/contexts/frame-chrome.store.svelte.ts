// Frame-level chrome shared between EditorLayout (which owns the sidebar /
// project-panel state) and the full-page sub-views (Folio, Plans, Settings)
// that host the "expand" affordances inline in their own headers. EditorLayout
// stays the source of truth and mirrors its state here; the page headers read
// it to decide whether to show the control and which toggle to call.
class FrameChromeStore {
  sidebarOpen = $state(true)
  projectPanelOpen = $state(false)
  expandSidebar = $state<(() => void) | null>(null)
  expandProjectPanel = $state<(() => void) | null>(null)
}

export const frameChrome = new FrameChromeStore()
