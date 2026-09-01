import { clampDimension, type BrowserViewport } from '@solus/contracts/browser-types'
import type { NativeSurfaceRect } from './native-surface-coordinator.svelte'

/**
 * The stage: a letterboxed area showing a device viewport at true CSS pixels,
 * scaled down only when the pane is smaller than the device.
 *
 * Scaling down rather than resizing the guest is what makes the browser honest.
 * A 1920px desktop layout squeezed into a 700px pane by *resizing* is a tablet
 * layout, not a shrunken desktop one — so the guest keeps its declared width
 * and the picture is scaled instead.
 */

/** A rectangle in CSS pixels: room on the stage, or a size for the page in it. */
export interface StageSize {
  width: number
  height: number
}

export interface StageFit {
  /** CSS pixels of the guest itself. */
  deviceWidth: number
  deviceHeight: number
  /** 1 when the device fits; below 1 when the stage had to shrink it. */
  scale: number
  /** Painted size after scaling — what the placeholder reserves. */
  paintedWidth: number
  paintedHeight: number
}

/**
 * Room left for the stage after its own padding. A filling page keeps none of
 * it: the point of fill is that the page is the size of the space.
 *
 * The letterbox is what makes the page's own edges visible even when the site's
 * background matches the app's, and it is also the only place the resize handles
 * can live — they sit outside the frame, because the guest is painted over the
 * frame by a layer no pane can reach into.
 */
export const STAGE_PADDING = 26

/**
 * The room a device is laid out in. Fill takes the pane whole; every other mode
 * is letterboxed, which is what makes the device's edges visible.
 */
export function stageRoom(
  viewport: BrowserViewport,
  availableWidth: number,
  availableHeight: number,
): StageSize {
  const padding = viewport.mode === 'fill' ? 0 : STAGE_PADDING
  return {
    width: Math.max(0, availableWidth - padding * 2),
    height: Math.max(0, availableHeight - padding * 2),
  }
}

export function fitStage(
  viewport: BrowserViewport,
  availableWidth: number,
  availableHeight: number,
): StageFit {
  const { width, height } = stageRoom(viewport, availableWidth, availableHeight)
  // An unmeasured stage reserves nothing. Falling back to the device's own size
  // would make the placeholder larger than the pane, and the guest is painted
  // from that placeholder's rectangle in a fixed layer that nothing clips — so
  // a 1512px device would spill across the whole window instead of being
  // cropped by the pane. The container's own observer re-runs this the moment
  // it has a width.
  if (width <= 0 || height <= 0) {
    return { deviceWidth: viewport.width, deviceHeight: viewport.height, scale: 0, paintedWidth: 0, paintedHeight: 0 }
  }
  const scale = Math.min(1, width / viewport.width, height / viewport.height)
  return {
    deviceWidth: viewport.width,
    deviceHeight: viewport.height,
    scale,
    paintedWidth: Math.round(viewport.width * scale),
    paintedHeight: Math.round(viewport.height * scale),
  }
}

/** The size a filling page asks for: the whole stage, within the bounds any
 *  viewport has. A pane dragged narrower than the floor stops resizing the page
 *  rather than asking for a viewport nothing can lay out in. */
export function fillSize(
  availableWidth: number,
  availableHeight: number,
): StageSize {
  return { width: clampDimension(availableWidth), height: clampDimension(availableHeight) }
}

/** Which edge of the stage a drag is holding. */
export type StageResizeEdge = 'east' | 'south' | 'southeast'

/**
 * The viewport a drag on the stage's edge is asking for.
 *
 * The stage is centred, so the edge the pointer holds is only half the change:
 * moving it 10px out grows the device by 20. Pointer travel is divided by the
 * scale first, so dragging a 1920px page shown at 50% still tracks the pointer.
 */
export function resizeViewport(
  start: StageSize,
  delta: { x: number; y: number },
  scale: number,
  edge: StageResizeEdge,
): StageSize {
  if (!(scale > 0)) return { width: start.width, height: start.height }
  const growsWidth = edge === 'east' || edge === 'southeast'
  const growsHeight = edge === 'south' || edge === 'southeast'
  return {
    width: clampDimension(start.width + (growsWidth ? (delta.x * 2) / scale : 0)),
    height: clampDimension(start.height + (growsHeight ? (delta.y * 2) / scale : 0)),
  }
}

/**
 * Where a guest waits while no pane is showing it: far offscreen, at its own
 * size, and still CSS-visible.
 *
 * `display: none` stops a `<webview>` rendering at all. `visibility: hidden`
 * looks safer and is worse: the element stays alive while CDP Runtime and Input
 * commands stall against it, which would hang the snapshot and click an agent
 * still drives against a page whose pane is closed. Moving it out of view
 * leaves it completely live.
 */
export const PARKED_GUEST_OFFSET = -100_000

export interface GuestPlacement {
  /** The frame the guest is painted in, in viewport coordinates. */
  left: number
  top: number
  width: number
  height: number
  /** Painted size of the device inside that frame. */
  scale: number
  onScreen: boolean
  layer: NativeSurfaceRect['layer']
}

/**
 * Place one guest against the slot a pane published for it.
 *
 * The frame is the slot and the device is scaled inside it, so the frame's own
 * clipping is what keeps a guest inside the pane. A slot that is stale, or
 * larger than the pane, then crops the picture instead of painting a
 * device-sized rectangle across the workspace — the layer is fixed at app root,
 * where no pane can crop anything for it.
 */
export function placeGuest(viewport: BrowserViewport, slot: NativeSurfaceRect | undefined): GuestPlacement {
  if (!slot) {
    return {
      left: PARKED_GUEST_OFFSET,
      top: PARKED_GUEST_OFFSET,
      width: viewport.width,
      height: viewport.height,
      scale: 1,
      onScreen: false,
      layer: 'workspace',
    }
  }
  return {
    left: slot.left,
    top: slot.top,
    width: slot.width,
    height: slot.height,
    scale: slot.width / viewport.width,
    onScreen: true,
    layer: slot.layer,
  }
}
