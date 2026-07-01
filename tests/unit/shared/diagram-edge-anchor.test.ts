import { describe, test, expect } from 'bun:test'
import { facingAnchor, type AnchorRect } from '../../../src/shared/diagram-edge-anchor'

// A 100x40 card whose top-left sits at (x, y).
const card = (x: number, y: number): AnchorRect => ({ x, y, width: 100, height: 40 })

describe('facingAnchor', () => {
  // The bug this fixes: a handle-less edge used to anchor to the Left side even
  // when the target was to the right. The source must exit the side that points
  // at the target, and the target must be entered from the side facing back.
  test('target to the right: source exits right, target entered from left', () => {
    const source = card(0, 0)
    const target = card(300, 0)

    const s = facingAnchor(source, target)
    expect(s.side).toBe('right')
    expect(s.x).toBe(100) // right edge of source
    expect(s.y).toBe(20) // vertical centre

    const t = facingAnchor(target, source)
    expect(t.side).toBe('left')
    expect(t.x).toBe(300) // left edge of target
  })

  test('target to the left: source exits left, target entered from right', () => {
    const source = card(300, 0)
    const target = card(0, 0)
    expect(facingAnchor(source, target).side).toBe('left')
    expect(facingAnchor(target, source).side).toBe('right')
  })

  test('target below: source exits bottom, target entered from top', () => {
    const source = card(0, 0)
    const target = card(0, 300)

    const s = facingAnchor(source, target)
    expect(s.side).toBe('bottom')
    expect(s.x).toBe(50) // horizontal centre
    expect(s.y).toBe(40) // bottom edge

    expect(facingAnchor(target, source).side).toBe('top')
  })

  // The dominant axis decides horizontal vs vertical; a near-equal split must
  // still resolve deterministically rather than flicker between sides.
  test('diagonal favours the larger axis; exact tie resolves horizontal', () => {
    // dx (250) > dy (60) -> horizontal
    expect(facingAnchor(card(0, 0), card(250, 60)).side).toBe('right')
    // |dx| === |dy| -> horizontal by tie-break
    expect(facingAnchor(card(0, 0), card(100, 100)).side).toBe('right')
    // dy > dx -> vertical
    expect(facingAnchor(card(0, 0), card(60, 250)).side).toBe('bottom')
  })
})
