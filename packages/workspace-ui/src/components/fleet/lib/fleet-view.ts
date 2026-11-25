/**
 * How the host map is shown in its frame: a scale and a shift, in px. The map is
 * laid out at the width of its frame, so a small fleet fits as it is and nothing
 * moves; a tall one (a zone opened in place) is shrunk to fit while it stays
 * legible, and pans beyond that. Pure, so the gestures, the keys, and the tests
 * agree.
 */

export interface Size { w: number; h: number }
export interface ScenePoint { x: number; y: number }
export interface SceneRect { x: number; y: number; w: number; h: number }

/** The map is drawn at `translate(x, y) scale(scale)` from its top left corner. */
export interface FleetView {
  scale: number
  x: number
  y: number
}

export const VIEW_SCALE = {
  min: 0.35,
  max: 2.5,
  /** The smallest scale at which a card's name can be read: a fit stops here and pans. */
  legible: 0.6,
}

/** The frame's height: as tall as the map, between these bounds, in px. */
export const FRAME_HEIGHT = { min: 416, max: 736 }

export const IDENTITY_VIEW: FleetView = { scale: 1, x: 0, y: 0 }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** The frame grows with the map up to its bound, so a short map gets a short frame. */
export function frameHeight(sceneHeight: number): number {
  return Math.round(clamp(sceneHeight, FRAME_HEIGHT.min, FRAME_HEIGHT.max))
}

/**
 * The whole map in the frame, centered. It never grows past its size, and never
 * shrinks past legible: a map taller than that starts at its top and pans.
 */
export function fitView(scene: Size, frame: Size): FleetView {
  if (scene.w <= 0 || scene.h <= 0 || frame.w <= 0 || frame.h <= 0) return IDENTITY_VIEW
  const fits = Math.min(1, frame.w / scene.w, frame.h / scene.h)
  const scale = Math.max(VIEW_SCALE.legible, fits)
  const x = (frame.w - scene.w * scale) / 2
  const y = scene.h * scale <= frame.h ? (frame.h - scene.h * scale) / 2 : 0
  return { scale, x, y }
}

/** Zooms by `factor` about `anchor`, a point of the frame that stays where it is. */
export function zoomView(view: FleetView, factor: number, anchor: ScenePoint): FleetView {
  const scale = clamp(view.scale * factor, VIEW_SCALE.min, VIEW_SCALE.max)
  const ratio = scale / view.scale
  return { scale, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio }
}

export function panView(view: FleetView, dx: number, dy: number): FleetView {
  return { ...view, x: view.x + dx, y: view.y + dy }
}

/** Where a point of the map is in the frame. */
export function toFrame(view: FleetView, point: ScenePoint): ScenePoint {
  return { x: view.x + point.x * view.scale, y: view.y + point.y * view.scale }
}

/** Where a point of the frame is on the map. */
export function toScene(view: FleetView, point: ScenePoint): ScenePoint {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
}

/** Puts a point of the map in the middle of the frame, at a scale it can be read at. */
export function centerOn(view: FleetView, point: ScenePoint, frame: Size): FleetView {
  const scale = Math.max(view.scale, VIEW_SCALE.legible)
  return { scale, x: frame.w / 2 - point.x * scale, y: frame.h / 2 - point.y * scale }
}

/** The least pan that shows all of `rect` with `margin` px around it; the view as it is when it already shows it. */
export function revealRect(view: FleetView, rect: SceneRect, frame: Size, margin = 16): FleetView {
  const left = view.x + rect.x * view.scale
  const top = view.y + rect.y * view.scale
  const right = left + rect.w * view.scale
  const bottom = top + rect.h * view.scale
  const dx = left < margin ? margin - left : right > frame.w - margin ? frame.w - margin - right : 0
  const dy = top < margin ? margin - top : bottom > frame.h - margin ? frame.h - margin - bottom : 0
  return dx === 0 && dy === 0 ? view : panView(view, dx, dy)
}

/**
 * Keeps a point of the map where it was in the frame after the map was laid out
 * again: a zone that opens in place stays under the pointer, and the rest makes room.
 */
export function anchorView(view: FleetView, before: ScenePoint, after: ScenePoint): FleetView {
  return panView(view, (before.x - after.x) * view.scale, (before.y - after.y) * view.scale)
}
