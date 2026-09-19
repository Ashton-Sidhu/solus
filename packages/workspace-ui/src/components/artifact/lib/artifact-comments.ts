import type { CommentPin, PlanComment } from '@solus/contracts/types'
import { commentAuthor, isResolved } from '../../comments/lib/thread'
import {
  placeThreadCard,
  THREAD_CARD_WIDTH,
  type ThreadCardAnchor,
  type ThreadCardPlacement,
} from '../../diagram/lib/thread-card-position'

/**
 * Comments on an artifact (docs/plans/multiplayer-comments.md §4). A render is
 * an HTML document in a sandboxed frame with nothing to quote and no node to
 * ride, so a thread is pinned to a point over it — a fraction of the render's
 * width and height, which is the one coordinate that means the same thing in
 * every pane width and on every device. A thread with no pin is a note on the
 * whole render: the agent leaves those.
 */

/** Diameter of a pin, in pane pixels. The card sits at its top-right. */
export const PIN_SIZE = 22

export interface Box {
  width: number
  height: number
}

export interface Rect extends Box {
  left: number
  top: number
}

/** Where a pointer landed over the render, as fractions of its box. Clamped: a
 *  release just outside the edge is a pin on the edge, not a lost comment. */
export function pinFromPointer(clientX: number, clientY: number, rect: Rect): CommentPin {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return {
    x: rect.width > 0 ? clamp((clientX - rect.left) / rect.width) : 0,
    y: rect.height > 0 ? clamp((clientY - rect.top) / rect.height) : 0,
  }
}

/** Threads with a pin, in the order they were written; a pin's number is its place here. */
export function pinnedThreads(comments: readonly PlanComment[]): PlanComment[] {
  return comments.filter((c) => c.pin !== undefined)
}

/** The caption a new pin carries — its number among the pins on this render. */
export function nextPinLabel(comments: readonly PlanComment[]): string {
  return `Pin ${pinnedThreads(comments).length + 1}`
}

/** What a pin reads as: an open human thread, an agent's note, or a settled one. */
export type PinTone = 'open' | 'agent' | 'resolved'

export function pinTone(comment: PlanComment): PinTone {
  if (isResolved(comment)) return 'resolved'
  return commentAuthor(comment) === 'solus' ? 'agent' : 'open'
}

export interface PlacedPin {
  comment: PlanComment
  /** Its place among the render's pins, shown in the dot. */
  number: number
  /** Centre of the dot, in pane pixels. */
  left: number
  top: number
  tone: PinTone
}

/**
 * Every pin over the render at its place in the current box. Resolved threads
 * only show while asked for, and a number is stable across that toggle: it is a
 * thread's place among all pins, resolved or not, so "Pin 3" in a card and the
 * dot marked 3 are always the same thread.
 */
export function placePins(comments: readonly PlanComment[], box: Box, showResolved: boolean): PlacedPin[] {
  const placed: PlacedPin[] = []
  pinnedThreads(comments).forEach((comment, index) => {
    const tone = pinTone(comment)
    if (tone === 'resolved' && !showResolved) return
    placed.push({
      comment,
      number: index + 1,
      left: comment.pin!.x * box.width,
      top: comment.pin!.y * box.height,
      tone,
    })
  })
  return placed
}

/** A thread card as wide as the diagram's, or as wide as a narrow pane allows. */
export function cardWidthFor(pane: Box, inset = 16): number {
  return Math.max(200, Math.min(THREAD_CARD_WIDTH, pane.width - inset * 2))
}

/** The point a pinned thread's card hangs from: the dot's top-right. */
export function pinAnchor(pin: CommentPin, box: Box): ThreadCardAnchor {
  return { x: pin.x * box.width + PIN_SIZE / 2, y: pin.y * box.height - PIN_SIZE / 2 }
}

/** A note on the whole render hangs from the render's top-right corner. */
export function wholeRenderAnchor(pane: Box, cardWidth: number, inset = 16, gap = 14): ThreadCardAnchor {
  return { x: pane.width - inset - cardWidth - gap, y: inset }
}

/** Where a card lands for a thread, pinned or not, inside the render's box. */
export function placeCommentCard(comment: Pick<PlanComment, 'pin'>, cardHeight: number, pane: Box): ThreadCardPlacement {
  const width = cardWidthFor(pane)
  const anchor = comment.pin ? pinAnchor(comment.pin, pane) : wholeRenderAnchor(pane, width)
  return placeThreadCard({ anchor, card: { width, height: cardHeight }, pane, inspectorFootprint: 0 })
}
