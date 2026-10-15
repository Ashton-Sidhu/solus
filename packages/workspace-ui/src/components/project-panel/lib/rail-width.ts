import {
  defaultWorkspaceRailWidth,
  MIN_PRIMARY_PANE_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../layout/lib/workspace-body'

/**
 * Hide the rail before it crowds the conversation and composer. Below 1200px,
 * columns use their full width for the conversation. This applies to each pane
 * separately.
 */
export const PROJECT_RAIL_MIN_CONTAINER_WIDTH = 1200

/**
 * Whether the rail is actually on screen: the user's persisted preference,
 * room to honour it, and no temporary layout reason to minimize it. One rule,
 * read by the rail itself and by the layout that gutters against it, so the two
 * can't disagree about whether it's there.
 */
export function isProjectRailOpen(
  panelOpen: boolean,
  containerWidth: number,
  minimized = false,
): boolean {
  return panelOpen && !minimized && containerWidth >= PROJECT_RAIL_MIN_CONTAINER_WIDTH
}

/**
 * Before the user resizes it, the rail matches the session sidebar. A preferred
 * width then remains inside the same usable band and is still capped by what
 * the hosting conversation can spare. That cap matters in a split, where the
 * conversation can be far narrower than the window.
 */
export function projectRailWidth(
  workspaceWidth: number,
  containerWidth: number,
  preferredWidth?: number | null,
): number {
  const requestedWidth = preferredWidth ?? defaultWorkspaceRailWidth(workspaceWidth)
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    containerWidth - MIN_PRIMARY_PANE_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, requestedWidth),
  )
}
