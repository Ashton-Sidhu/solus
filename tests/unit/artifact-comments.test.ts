/// <reference types="bun-types" />
/**
 * A pin is the only thing that says where on a render a thread is. If it
 * drifts with the pane width, renumbers when a thread settles, or hangs its
 * card off the pane, the comment points at the wrong thing or at nothing.
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import type { PlanComment } from '@solus/contracts/types'
import {
  nextPinLabel,
  pinFromPointer,
  placeCommentCard,
  placePins,
} from '@solus/workspace-ui/components/artifact/lib/artifact-comments'

const thread = (extra: Partial<PlanComment>): PlanComment => ({ id: 'c', selectedText: 'Pin', comment: 'note', ...extra })

describe('pinFromPointer', () => {
  test('a click is a fraction of the render, so the pin lands on the same spot at every width', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }
    expect(pinFromPointer(200, 150, rect)).toEqual({ x: 0.25, y: 0.5 })
    expect(pinFromPointer(200, 150, { ...rect, width: 800 })).toEqual({ x: 0.125, y: 0.5 })
  })

  test('a release just past the edge is a pin on the edge, never a lost comment', () => {
    expect(pinFromPointer(0, 1000, { left: 100, top: 50, width: 400, height: 200 })).toEqual({ x: 0, y: 1 })
  })
})

describe('placePins', () => {
  const pinned = [
    thread({ id: 'a', pin: { x: 0.1, y: 0.2 } }),
    thread({ id: 'b', pin: { x: 0.5, y: 0.5 }, resolvedAt: 1 }),
    thread({ id: 'c', pin: { x: 0.9, y: 0.8 }, author: 'solus' }),
    thread({ id: 'note' }),
  ]

  test('a pin keeps its number when a resolved thread is hidden, so "Pin 3" is always the same dot', () => {
    const shown = placePins(pinned, { width: 1000, height: 500 }, false)
    expect(shown.map((p) => [p.comment.id, p.number, p.tone])).toEqual([['a', 1, 'open'], ['c', 3, 'agent']])
    expect(placePins(pinned, { width: 1000, height: 500 }, true).map((p) => p.number)).toEqual([1, 2, 3])
  })

  test('a whole-render note has no pin, and the next pin is numbered after the pinned ones only', () => {
    expect(placePins(pinned, { width: 1000, height: 500 }, true).some((p) => p.comment.id === 'note')).toBe(false)
    expect(nextPinLabel(pinned)).toBe('Pin 4')
  })

  test('a pin sits at its fraction of the box, in pixels', () => {
    const [first] = placePins(pinned, { width: 1000, height: 500 }, false)
    expect([first!.left, first!.top]).toEqual([100, 100])
  })
})

describe('placeCommentCard', () => {
  test('hangs beside its pin, flips when the pane edge is near, and stays inside a narrow pane', () => {
    const pane = { width: 1200, height: 800 }
    const beside = placeCommentCard({ pin: { x: 0.1, y: 0.5 } }, 200, pane)
    expect(beside.left).toBeGreaterThan(120)
    expect(beside.detached).toBe(false)
    const flipped = placeCommentCard({ pin: { x: 0.95, y: 0.5 } }, 200, pane)
    expect(flipped.left + 400).toBeLessThan(1140)
    const phone = placeCommentCard({ pin: { x: 0.5, y: 0.9 } }, 300, { width: 360, height: 640 })
    expect(phone.left).toBeGreaterThanOrEqual(16)
    expect(phone.top + 300).toBeLessThanOrEqual(640 - 16)
  })

  test('a note on the whole render hangs from the top-right corner, inside the pane', () => {
    const at = placeCommentCard({}, 200, { width: 1200, height: 800 })
    expect(at).toEqual({ left: 1200 - 16 - 400, top: 16, detached: false })
  })
})
