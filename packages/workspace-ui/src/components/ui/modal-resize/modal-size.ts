/**
 * The size of a large modal that the reader resized: the session picker,
 * Settings, the folder picker, search in files. A modal opens at its own default size; the reader drags
 * any edge or corner, and this device keeps the size for
 * that kind of modal. A double-click on a handle goes back to the default.
 */

export const MODAL_MIN_WIDTH = 320
export const MODAL_MIN_HEIGHT = 240

/** The space a modal always leaves between itself and the window edge. */
const VIEWPORT_MARGIN = 16

/** One kind of resizable modal: each kind keeps its own size. */
export type ModalSizeKey =
  | 'session-picker'
  | 'settings'
  | 'directory-picker'
  | 'project-search'

/** Where the modal sits in the window. A centred modal grows on both sides, so
 *  the dragged edge moves half as far as its size changes; a modal pinned near
 *  the top grows only downward. Every resizable modal is centred horizontally. */
export type ModalAnchor = 'center' | 'top'

/** The edge or corner that the reader drags. */
export type ModalEdge =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

/** Which way each handle moves its edge: +1 grows the modal when the pointer
 *  moves right or down, -1 when it moves left or up, 0 leaves that size. */
const EDGE_DIRECTION = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  'top-left': { x: -1, y: -1 },
  'top-right': { x: 1, y: -1 },
  'bottom-left': { x: -1, y: 1 },
  'bottom-right': { x: 1, y: 1 },
} as const satisfies Record<ModalEdge, { x: -1 | 0 | 1; y: -1 | 0 | 1 }>

/** A modal pinned near the top cannot move its top edge, so it has no handles
 *  there. */
export function hasTopHandles(anchor: ModalAnchor): boolean {
  return anchor === 'center'
}

export interface ModalSize {
  width: number
  height: number
}

/** A modal card as it is on screen now, and the largest size it can take. */
export interface ModalBox {
  size: ModalSize
  max: ModalSize
}

export function measureModal(card: DOMRect, viewport: ModalSize, anchor: ModalAnchor): ModalBox {
  return {
    size: { width: card.width, height: card.height },
    max: maxModalSize(viewport, card.top, anchor),
  }
}

/** The largest size the modal can take in this window, from where its top is. */
export function maxModalSize(
  viewport: ModalSize,
  top: number,
  anchor: ModalAnchor,
): ModalSize {
  return {
    width: viewport.width - VIEWPORT_MARGIN * 2,
    height: anchor === 'center' ? viewport.height - VIEWPORT_MARGIN * 2 : viewport.height - top - VIEWPORT_MARGIN,
  }
}

/** The size after the reader moves `edge` by `delta` from where it started. */
export function resizeModal(
  start: ModalSize,
  delta: { x: number; y: number },
  edge: ModalEdge,
  anchor: ModalAnchor,
  max: ModalSize,
): ModalSize {
  const direction = EDGE_DIRECTION[edge]
  return clampModalSize(
    {
      width: start.width + delta.x * direction.x * 2,
      height: start.height + delta.y * direction.y * (anchor === 'center' ? 2 : 1),
    },
    max,
  )
}

/** Holds a size between the floor and the window. A window smaller than the
 *  floor gets the floor. */
export function clampModalSize(size: ModalSize, max: ModalSize): ModalSize {
  return {
    width: Math.round(clamp(size.width, MODAL_MIN_WIDTH, max.width)),
    height: Math.round(clamp(size.height, MODAL_MIN_HEIGHT, max.height)),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, value))
}

/** The inline style that replaces the modal's default size. The window can
 *  shrink after the reader chose a size, so the size never goes past it. */
export function modalSizeStyle(size: ModalSize | null): string | undefined {
  if (!size) return undefined
  return `width: min(${size.width}px, 100vw - ${VIEWPORT_MARGIN * 2}px); height: min(${size.height}px, 100dvh - ${VIEWPORT_MARGIN * 2}px); max-width: none; max-height: none;`
}

function storageKey(key: ModalSizeKey): string {
  return `solus.modal-size.${key}`
}

export function readSavedModalSize(
  key: ModalSizeKey,
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): ModalSize | null {
  let raw: string | null | undefined
  try {
    raw = storage?.getItem(storageKey(key))
  } catch {
    return null
  }
  const [width, height] = (raw ?? '').split('x').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < MODAL_MIN_WIDTH || height < MODAL_MIN_HEIGHT) return null
  return { width, height }
}

export function saveModalSize(
  key: ModalSizeKey,
  size: ModalSize | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage,
): void {
  try {
    if (size) storage?.setItem(storageKey(key), `${size.width}x${size.height}`)
    else storage?.removeItem(storageKey(key))
  } catch {
    // Storage full or blocked: the size holds for this visit only.
  }
}
