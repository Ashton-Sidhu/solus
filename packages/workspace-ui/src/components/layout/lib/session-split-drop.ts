import { COMPANION_PANE_DEFAULT_SIZE } from './workspace-body'

/** A horizontal stretch of the workspace, in window pixels. */
export interface Span {
  left: number
  right: number
}

/**
 * Where a session dragged from the sidebar opens beside the destination, when
 * the pointer at `x` is over that place. With the companion pane open, the
 * pane takes the session as one more surface. With it closed, the stretch the
 * pane opens into takes it. Null when the pointer is over the destination.
 */
export function sessionSplitDropZone(x: number, split: Span, companion: Span | null): Span | null {
  const zone = companion ?? {
    left: split.right - ((split.right - split.left) * COMPANION_PANE_DEFAULT_SIZE) / 100,
    right: split.right,
  }
  return x >= zone.left && x <= zone.right ? zone : null
}
