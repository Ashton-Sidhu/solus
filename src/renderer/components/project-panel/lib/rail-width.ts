import {
  defaultWorkspaceRailWidth,
  MIN_PRIMARY_PANE_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../layout/lib/workspace-body'

/**
 * Narrowest conversation view that can still host the rail. Derived from the two
 * minimums rather than picked: at exactly this width the rail sits at its floor
 * and the conversation at `MIN_PRIMARY_PANE_WIDTH`, so the constants meet with no
 * gap and no overlap. Below it the rail minimizes to zero — which is also why
 * `MIN_PRIMARY_PANE_WIDTH` never has to grow to cover the rail.
 */
export const PROJECT_RAIL_MIN_CONTAINER_WIDTH = MIN_PRIMARY_PANE_WIDTH + SIDEBAR_MIN_WIDTH

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
 * The rail matches the session sidebar — same window, same furniture, same
 * width — instead of taking its own share of the conversation view. Sizing it
 * off the window alone would break in a split, where the hosting view can be far
 * narrower than the window, so the sidebar's measure is capped by what the
 * conversation can actually give away. Above `PROJECT_RAIL_MIN_CONTAINER_WIDTH`
 * that floor is never below the sidebar's own.
 */
export function projectRailWidth(workspaceWidth: number, containerWidth: number): number {
  return Math.min(
    defaultWorkspaceRailWidth(workspaceWidth),
    containerWidth - MIN_PRIMARY_PANE_WIDTH,
  )
}
