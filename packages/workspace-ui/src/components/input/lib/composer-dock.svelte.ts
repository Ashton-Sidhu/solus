import { resolveComposerInset } from './composer-collapse'
import {
  COMPOSER_COLLAPSED_ATTRIBUTE,
  COMPOSER_FOLD_DURATION_MS,
  COMPOSER_FOLD_EASING,
  COMPOSER_SURFACE_ATTRIBUTE,
} from './composer-fold'

/**
 * The composer's reserved band (ADR-0027), measured off the dock that floats
 * over the bottom of a conversation column.
 *
 * The dock floats instead of standing in flow beside the transcript, and the
 * column reserves the band it needs through `--solus-composer-inset`. A dock in
 * flow resized the transcript every time the bar folded: the scroll viewport
 * grew, the browser clamped `scrollTop` to the smaller maximum, and the whole
 * conversation slid by the fold distance under the reader. Floating it means
 * the transcript's box never changes, and holding the reservation at the
 * expanded height means folding does not move the band either.
 *
 * Two vars come out of the same measurement, because the column's chrome wants
 * two different answers. `--solus-composer-inset` is the held band: the
 * transcript's bottom padding and the minimap's centre take it, and neither
 * moves with a fold. `--solus-composer-height` is where the bar's top edge
 * actually is right now: the action row hugs it, because that row belongs to
 * the bar rather than to the transcript.
 *
 * One instance per column; `WorkspaceBody` and the guest shell each own one.
 */
export class ComposerDock {
  /** The held band under the transcript. A fold may hold it, never shrink it. */
  inset = $state(0)
  /** Where the bar's top edge is right now. */
  height = $state(0)
  /** The action row's travel is armed only after the bar's first measurement.
   *  Otherwise the opening move — no bar, then a bar — is itself a change of
   *  the edge the row rides, and every conversation would open by sliding its
   *  action row up through the fold's whole 280ms. */
  hasMeasured = $state(false)

  /** Watch the dock element; returns the disconnect. */
  observe(dock: HTMLElement): () => void {
    const observer = new ResizeObserver(() => {
      const dockHeight = dock.getBoundingClientRect().height
      // A hidden dock measures zero and says nothing about the band it will
      // want back; the reservation it had is the honest answer until it
      // returns. `columnStyle` zeroes both vars while it is away regardless.
      if (dockHeight <= 0) return
      this.height = dockHeight
      this.inset = resolveComposerInset({
        currentInset: this.inset,
        dockHeight,
        collapsed:
          dock.querySelector(`[${COMPOSER_SURFACE_ATTRIBUTE}][${COMPOSER_COLLAPSED_ATTRIBUTE}]`) !== null,
      })
      if (!this.hasMeasured) {
        requestAnimationFrame(() => {
          this.hasMeasured = true
        })
      }
    })
    observer.observe(dock)
    return () => observer.disconnect()
  }

  /** The vars the column publishes for its transcript and chrome. A column whose
   *  dock has stepped aside (a page over the pool) publishes no band at all. */
  columnStyle(dockVisible: boolean): string {
    const inset = dockVisible ? this.inset : 0
    const height = dockVisible ? this.height : 0
    const duration = this.hasMeasured ? COMPOSER_FOLD_DURATION_MS : 0
    return `--solus-composer-inset:${inset}px;--solus-composer-height:${height}px;--solus-composer-fold-duration:${duration}ms;--solus-composer-fold-easing:${COMPOSER_FOLD_EASING}`
  }
}
