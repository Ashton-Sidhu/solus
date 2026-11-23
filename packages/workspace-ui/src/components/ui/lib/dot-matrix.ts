import { DOT_GAP_PX, DOT_GRID_SIZE, DOT_SIZE_PX, type DotKeyframe, type DotMarkName } from '@solus/client-core/dot-marks'

/** The Web Animations keyframes of one dot. Only `transform: scale` moves. */
export function dotAnimationKeyframes(keyframes: readonly DotKeyframe[]): Keyframe[] {
  return keyframes.map(({ offset, scale, easing }) => {
    const keyframe: Keyframe = { offset, transform: `scale(${scale})` }
    if (easing) keyframe.easing = easing
    return keyframe
  })
}

/** The time to the end of the current cycle of a mark whose cycles start at
 *  the timeline origin (`startTime = 0`). A time on a cycle edge is the start
 *  of a new cycle, so it waits a whole cycle. */
export function msUntilCycleEnd(timelineMs: number, durationMs: number): number {
  return durationMs - (timelineMs % durationMs)
}

/** What the grid does when the mark it is asked to show changes. */
export type DotMarkSwitch =
  | { kind: 'keep' }
  | { kind: 'now' }
  | { kind: 'atCycleEnd'; delayMs: number }

/**
 * Hold for whole cycles (docs/plans/session-state-marks.md): the mark on
 * screen completes its cycle before the next one starts. A mark that is asked
 * for and then replaced inside the wait never shows, because the switch shows
 * the newest mark asked for. Nothing on screen, or reduced motion, switches at
 * once: a still mark has no cycle to finish.
 */
export function planDotMarkSwitch(input: {
  shown: DotMarkName | null
  requested: DotMarkName | null
  shownDurationMs: number
  timelineMs: number
  reducedMotion: boolean
}): DotMarkSwitch {
  if (input.requested === input.shown) return { kind: 'keep' }
  if (!input.shown || !input.requested || input.reducedMotion) return { kind: 'now' }
  return { kind: 'atCycleEnd', delayMs: msUntilCycleEnd(input.timelineMs, input.shownDurationMs) }
}

/** The box of the grid at the default dot size and gap: 13px, the box of the
 *  line glyphs. */
export const DOT_MATRIX_BOX_PX = DOT_GRID_SIZE * DOT_SIZE_PX + (DOT_GRID_SIZE - 1) * DOT_GAP_PX

/** The top-left corner of a cell in a grid of `boxPx`, with dot and gap scaled
 *  from their defaults. */
export function dotCellOffset(index: number, boxPx: number): number {
  return index * ((DOT_SIZE_PX + DOT_GAP_PX) * boxPx) / DOT_MATRIX_BOX_PX
}

export function dotSizePx(boxPx: number): number {
  return (DOT_SIZE_PX * boxPx) / DOT_MATRIX_BOX_PX
}
