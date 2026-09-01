import type { PaneId } from './location'

export const DEFAULT_PANEL_WIDTH = 560
export const DEFAULT_PANE_WEIGHT = 0.5
export const MIN_PANE_WEIGHT = 0.25
export const MAX_PANE_WEIGHT = 0.75

export function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) return DEFAULT_PANE_WEIGHT
  return Math.min(MAX_PANE_WEIGHT, Math.max(MIN_PANE_WEIGHT, weight))
}

/**
 * How wide each pane is and whether one is maximized — kept beside the location
 * rather than inside it, because geometry is not part of where you are. Keying
 * it by pane id is what makes it N-shaped: a weight per pane instead of a single
 * `secondaryRatio` scalar.
 */
export class PaneGeometryStore {
  /** Fraction of the split area a pane claims when it opens, before any drag. */
  weights = $state<Record<PaneId, number>>({})
  /** Last measured width in px, once the user has dragged a divider. */
  widths = $state<Record<PaneId, number>>({})
  /** A pane the user has sized by hand keeps that size until it reopens. */
  resized = $state<Record<PaneId, boolean>>({})
  maximizedPaneId = $state<PaneId | null>(null)

  weightFor(paneId: PaneId): number {
    return this.weights[paneId] ?? DEFAULT_PANE_WEIGHT
  }

  widthFor(paneId: PaneId): number {
    return this.widths[paneId] ?? DEFAULT_PANEL_WIDTH
  }

  hasResized(paneId: PaneId): boolean {
    return this.resized[paneId] ?? false
  }

  isMaximized(paneId: PaneId): boolean {
    return this.maximizedPaneId === paneId
  }

  /** A surface entering a pane sizes it to its own measure and clears any
   *  previous hand-drag, the way opening a new secondary always has. */
  open(paneId: PaneId, weight = DEFAULT_PANE_WEIGHT): void {
    this.weights[paneId] = clampWeight(weight)
    this.resized[paneId] = false
    if (this.maximizedPaneId === paneId) this.maximizedPaneId = null
  }

  setWidth(paneId: PaneId, width: number): void {
    this.widths[paneId] = width
  }

  markResized(paneId: PaneId): void {
    this.resized[paneId] = true
    if (this.maximizedPaneId === paneId) this.maximizedPaneId = null
  }

  toggleMaximize(paneId: PaneId): void {
    this.maximizedPaneId = this.maximizedPaneId === paneId ? null : paneId
  }

  maximize(paneId: PaneId): void {
    this.maximizedPaneId = paneId
  }

  restore(): void {
    this.maximizedPaneId = null
  }

  /** Drop geometry for panes that no longer exist, so these maps stay bounded
   *  by the number of open panes rather than by how many have ever opened. */
  prune(livePaneIds: readonly PaneId[]): void {
    const live = new Set(livePaneIds)
    for (const id of Object.keys(this.weights)) if (!live.has(id)) delete this.weights[id]
    for (const id of Object.keys(this.widths)) if (!live.has(id)) delete this.widths[id]
    for (const id of Object.keys(this.resized)) if (!live.has(id)) delete this.resized[id]
    if (this.maximizedPaneId && !live.has(this.maximizedPaneId)) this.maximizedPaneId = null
  }
}
