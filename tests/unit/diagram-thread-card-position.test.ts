/// <reference types="bun-types" />
/**
 * The thread card is the one overlay that has to share the pane with the
 * inspector. If it lands under the inspector the reply box is unreachable, and
 * if it lands off the pane edge the thread is simply gone — both look like the
 * pin did nothing.
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import { placeThreadCard } from '../../src/renderer/components/diagram/lib/thread-card-position'

const pane = { width: 1200, height: 800 }
const card = { width: 252, height: 200 }

describe('placeThreadCard', () => {
  test('sits beside its pin when there is room', () => {
    const at = placeThreadCard({ anchor: { x: 400, y: 300 }, card, pane, inspectorFootprint: 0 })
    expect(at).toEqual({ left: 414, top: 300, detached: false })
  })

  test('flips to the pin’s other side rather than running off the pane', () => {
    const at = placeThreadCard({ anchor: { x: 1100, y: 300 }, card, pane, inspectorFootprint: 0 })
    expect(at.left).toBe(1100 - 14 - 252)
    expect(at.detached).toBe(false)
  })

  test('gives up the flip when neither side fits, and lands clear of the inspector', () => {
    // A pin already under the inspector has no free side: the card takes the
    // rightmost column that still clears the panel rather than hiding beneath it.
    const at = placeThreadCard({ anchor: { x: 900, y: 300 }, card, pane, inspectorFootprint: 408 })
    expect(at.left).toBe(1200 - 408 - 252)
    expect(at.detached).toBe(true)
  })

  test('a collapsed rail frees the space the open panel was claiming', () => {
    const railed = placeThreadCard({ anchor: { x: 700, y: 300 }, card, pane, inspectorFootprint: 84 })
    expect(railed.left).toBe(714)
    const open = placeThreadCard({ anchor: { x: 700, y: 300 }, card, pane, inspectorFootprint: 408 })
    expect(open.left).toBe(700 - 14 - 252)
  })

  test('clamps into the pane and says so when the anchor is off screen', () => {
    const at = placeThreadCard({ anchor: { x: -600, y: 780 }, card, pane, inspectorFootprint: 0 })
    expect(at.left).toBe(16)
    expect(at.top).toBe(800 - 16 - 200)
    expect(at.detached).toBe(true)
  })
})
