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
import type { Edge, Node } from '@xyflow/svelte'
import {
  anchorRectFor,
  placeThreadCard,
} from '../../src/renderer/components/diagram/lib/thread-card-position'

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

function node(id: string, x: number, y: number, extra: Partial<Node> = {}): Node {
  return {
    id,
    position: { x, y },
    width: 200,
    height: 80,
    data: {},
    ...extra,
  } as Node
}

/**
 * The composer and the open thread's card share this, so a rect that is wrong
 * here puts a new thread somewhere other than the thing it comments on.
 */
describe('anchorRectFor', () => {
  test('a node anchors to its own top-left and width', () => {
    const nodes = [node('a', 300, 120)]
    expect(anchorRectFor({ nodeId: 'a' }, nodes, [])).toEqual({ x: 300, y: 120, width: 200 })
  })

  test('a node inside a group anchors absolutely, not relative to its parent', () => {
    // Relative coordinates would drop the card near the canvas origin while the
    // node itself sits deep inside the group.
    const nodes = [
      node('g', 1000, 500, { data: { group: true }, width: 600, height: 400 }),
      node('a', 40, 60, { parentId: 'g' }),
    ]
    expect(anchorRectFor({ nodeId: 'a' }, nodes, [])).toEqual({ x: 1040, y: 560, width: 200 })
  })

  test('an edge has no box, so its thread rides the midpoint between endpoint centres', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 200)]
    const edges = [{ id: 'e', source: 'a', target: 'b' } as Edge]
    // Centres are (100, 40) and (500, 240); the midpoint is (300, 140).
    expect(anchorRectFor({ edgeId: 'e' }, nodes, edges)).toEqual({ x: 300, y: 140, width: 0 })
  })

  test('an anchor on another level has no rect, which is what earns the card its off-screen clamp', () => {
    expect(anchorRectFor({ nodeId: 'gone' }, [node('a', 0, 0)], [])).toBeNull()
    expect(anchorRectFor({ edgeId: 'gone' }, [node('a', 0, 0)], [])).toBeNull()
  })
})
