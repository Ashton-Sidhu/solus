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
 * The narrowest view that can still hold a rail beside the conversation. Below
 * 1200px the rail hides on its own, but the user may reveal it down to here.
 */
export const PROJECT_RAIL_REVEAL_MIN_CONTAINER_WIDTH = MIN_PRIMARY_PANE_WIDTH + SIDEBAR_MIN_WIDTH

/**
 * Whether the rail is actually on screen: the user's persisted preference,
 * room to honour it, and no temporary layout reason to minimize it. One rule,
 * read by the rail itself and by the layout that gutters against it, so the two
 * can't disagree about whether it's there. `revealed` is the user opening the
 * rail in a view too narrow for it to open on its own.
 */
export function isProjectRailOpen(
  panelOpen: boolean,
  containerWidth: number,
  minimized = false,
  revealed = false,
): boolean {
  if (!panelOpen || minimized) return false
  if (containerWidth >= PROJECT_RAIL_MIN_CONTAINER_WIDTH) return true
  return revealed && containerWidth >= PROJECT_RAIL_REVEAL_MIN_CONTAINER_WIDTH
}

/**
 * Whether the conversation band offers to expand the rail: it is off screen
 * and the view has room to show it. A rail hidden only for width counts, so
 * the user always has a way to open it.
 */
export function canExpandProjectRail(
  panelOpen: boolean,
  containerWidth: number,
  revealed: boolean,
): boolean {
  return (
    containerWidth >= PROJECT_RAIL_REVEAL_MIN_CONTAINER_WIDTH &&
    !isProjectRailOpen(panelOpen, containerWidth, false, revealed)
  )
}

/**
 * One press of the rail toggle. It acts on what is on screen, not on the stored
 * preference, so a press on a rail hidden for width opens it. A press in a
 * narrow view records a reveal, which keeps the rail open there until the user
 * closes it.
 */
export function toggleProjectRail(
  panelOpen: boolean,
  containerWidth: number,
  revealed: boolean,
) {
  const open = !isProjectRailOpen(panelOpen, containerWidth, false, revealed)
  return { open, revealed: open && containerWidth < PROJECT_RAIL_MIN_CONTAINER_WIDTH }
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
