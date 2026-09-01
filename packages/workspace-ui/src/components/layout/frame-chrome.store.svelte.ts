// Frame-level chrome shared between the shells and the full-page sub-views
// (Folio, Plans, Settings, Tasks, Pull requests) that host the frame's
// affordances inline in their own headers. This is a one-way published
// projection: readers (FrameExpandButton and page headers) must never write it.
//
// Two shells publish into it, and each owns a disjoint set of fields:
//   - WorkspaceBody's mirror effect owns the sidebar / project-panel pair
//     (settings owns the persisted project-panel flag itself).
//   - The web client's mobile shell owns the navigation drawer, which exists
//     only there — the desktop frame has a session sidebar in its place.
//
// A command is null when the surrounding shell has nothing to offer, which is
// how a page header knows not to draw a control that would do nothing.
class FrameChromeStore {
  sidebarOpen = $state(true)
  projectPanelOpen = $state(false)
  expandSidebar = $state<(() => void) | null>(null)
  toggleProjectPanelFromFrame = $state<(() => void) | null>(null)
  /** Opens the mobile navigation drawer — the surface carrying the section list
   *  and the task list. Null on every shell that has no drawer. */
  openNavigationDrawer = $state<(() => void) | null>(null)
  /** Something moved in a section the reader is not currently looking at. Drawn
   *  as a dot on the control above, so the drawer is worth opening before it is
   *  opened. */
  navigationHasUnseen = $state(false)
}

export const frameChrome = new FrameChromeStore()
