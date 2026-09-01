/**
 * Pane width for the decisions CSS cannot make.
 *
 * Most of this migration is a container query: a rung hides a control, a `cqi`
 * sizes a column, and no JavaScript is involved. A few decisions are not
 * expressible that way — PaneForge's split `direction` and pane sizes are
 * component props, and a virtualiser's row height is a number — so those
 * surfaces still need a width. This gives them the *pane's* width instead of
 * the window's, which is the whole point of the migration; see
 * `docs/plans/responsive-surfaces.md`.
 *
 * Observe the surface's own root element, not an ancestor: the box a component
 * occupies is the thing it should size itself against, and it saves coupling
 * every caller to `WorkspaceBody`'s class names.
 *
 * The two rungs are the same numbers the CSS ladder uses, deliberately. A
 * surface that stacks at one width in CSS and another in JavaScript has two
 * layouts and no rule.
 */

const REM = 16

/**
 * Below this a pane cannot hold two columns side by side — the tree and the
 * thing it navigates each end up too narrow to read. Stack instead. Same
 * 30rem as the composer ladder's first rung.
 */
export const PANE_STACKED_MAX = 30 * REM

/**
 * Below this a pane is narrow enough that chrome should tighten: shorter
 * headers, fewer optional affordances. Same 48rem as the Settings nav rail.
 */
export const PANE_COMPACT_MAX = 48 * REM

/** A pane too narrow for a side-by-side split. */
export function isStackedPane(width: number): boolean {
  // Width 0 is the frame before the observer reports. Answering "stacked" then
  // would flash the phone layout on every mount on a wide display.
  return width > 0 && width < PANE_STACKED_MAX
}

/** A pane narrow enough to tighten chrome, which every stacked pane also is. */
export function isCompactPane(width: number): boolean {
  return width > 0 && width < PANE_COMPACT_MAX
}

/**
 * Reports `el`'s inline size now, and again whenever it changes. Returns a
 * teardown.
 *
 * `ResizeObserver` alone is enough here — unlike `observeConversationBounds`,
 * which also listens for window resize because it tracks the column's *position*
 * as well as its size. Width is width.
 */
export function observePaneWidth(el: HTMLElement, onChange: (width: number) => void): () => void {
  const report = () => onChange(el.getBoundingClientRect().width)
  report()
  const observer = new ResizeObserver(report)
  observer.observe(el)
  return () => observer.disconnect()
}

/**
 * Reports the *content* box of a declared `@container`, and again on every
 * change. Returns a teardown.
 *
 * This is the border-box function's question asked about a different box, and
 * the difference is the whole point. `observePaneWidth` answers "how wide is
 * this surface", which is what a surface sizing itself wants. A reading that
 * has to agree with a container-query rung is asking something narrower: a
 * `container-type: inline-size` container resolves its rungs against the
 * *content* box, so a padded container is already narrower to the stylesheet
 * than `getBoundingClientRect` reports. Measured the other way, a fold and the
 * control that is supposed to replace it disagree about which layout is on
 * screen — by exactly the container's horizontal padding, which is 104px on a
 * PR review.
 *
 * No synchronous first report: `ResizeObserver` fires on `observe`, and width 0
 * until it does is the same "before the observer answers" frame the rung
 * predicates already guard against.
 */
export function observeContainerWidth(
  el: HTMLElement,
  onChange: (width: number) => void,
): () => void {
  const observer = new ResizeObserver(([entry]) => {
    const box = entry?.contentBoxSize?.[0]
    onChange(box ? box.inlineSize : el.clientWidth)
  })
  observer.observe(el)
  return () => observer.disconnect()
}
