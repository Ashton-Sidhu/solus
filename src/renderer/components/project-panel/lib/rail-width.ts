import { MIN_PRIMARY_PANE_WIDTH } from '../../layout/lib/workspace-body'

export const PROJECT_RAIL_MIN_WIDTH = 240
export const PROJECT_RAIL_MAX_WIDTH = 380

/**
 * Narrowest conversation view that can still host the rail. Derived from the two
 * minimums rather than picked: at exactly this width the rail sits at its floor
 * and the conversation at `MIN_PRIMARY_PANE_WIDTH`, so the constants meet with no
 * gap and no overlap. Below it the rail minimizes to zero — which is also why
 * `MIN_PRIMARY_PANE_WIDTH` never has to grow to cover the rail.
 */
export const PROJECT_RAIL_MIN_CONTAINER_WIDTH = MIN_PRIMARY_PANE_WIDTH + PROJECT_RAIL_MIN_WIDTH

/** Share of the conversation view the rail claims between its two bounds. */
const PROJECT_RAIL_RATIO = 0.26

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
 * The rail scales with the conversation view instead of being dragged: narrower
 * on a split or laptop-width column, wider beside a roomy thread, bounded to a
 * band where its cards still read. Mirrors `defaultWorkspaceRailWidth`, which
 * sizes the session sidebar the same way against the viewport.
 */
export function projectRailWidth(containerWidth: number): number {
  return Math.round(
    Math.min(
      PROJECT_RAIL_MAX_WIDTH,
      Math.max(PROJECT_RAIL_MIN_WIDTH, containerWidth * PROJECT_RAIL_RATIO),
    ),
  )
}
