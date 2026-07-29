import { describe, expect, test } from 'bun:test'
import {
  CONNECTOR_THRESHOLD,
  MIN_GAP,
  layoutThreads,
} from '../../src/renderer/components/comments/lib/rail-layout'

// A thread card is a margin note: it means "this, here". These tests pin the
// three properties that keep it saying that — a card sits on its anchor's line
// when it can, a card that has been pushed off admits it with a connector, and
// the thread the reader is actually in is the one that keeps its line.

describe('rail layout', () => {
  test('a card with room sits on its anchor line', () => {
    const { tops, connectors } = layoutThreads([
      { id: 'a', anchorTop: 100, height: 80 },
      { id: 'b', anchorTop: 400, height: 80 },
    ])
    // Lifted 2px so the card's cap height lines up with the text, not its border.
    expect(tops.get('a')).toBe(98)
    expect(tops.get('b')).toBe(398)
    // Nothing drifted, so nothing needs a line drawn back to its highlight.
    expect(connectors.size).toBe(0)
  })

  test('colliding cards push down in anchor order and never touch', () => {
    const { tops } = layoutThreads([
      { id: 'b', anchorTop: 120, height: 80 },
      { id: 'a', anchorTop: 100, height: 80 },
    ])
    // Anchor order, not input order — the margin reads top to bottom.
    expect(tops.get('a')).toBe(98)
    expect(tops.get('b')).toBe(98 + 80 + MIN_GAP)
    expect(tops.get('b')! - (tops.get('a')! + 80)).toBe(MIN_GAP)
  })

  test('a card drifts silently until it is far enough to need a connector', () => {
    // Second anchor sits just below the first card's foot: a small push.
    const near = layoutThreads([
      { id: 'a', anchorTop: 100, height: 80 },
      { id: 'b', anchorTop: 100 + 80 + MIN_GAP - CONNECTOR_THRESHOLD, height: 80 },
    ])
    expect(near.connectors.has('b')).toBe(false)

    const far = layoutThreads([
      { id: 'a', anchorTop: 100, height: 80 },
      { id: 'b', anchorTop: 110, height: 80 },
    ])
    // b wanted 108 and got 188 — 80px off its line, so it draws the curve.
    expect(far.connectors.has('b')).toBe(true)
    expect(far.connectors.has('a')).toBe(false)
  })

  test('the focused card wins its line and the others yield around it', () => {
    const items = [
      { id: 'a', anchorTop: 100, height: 80 },
      { id: 'b', anchorTop: 130, height: 80 },
      { id: 'c', anchorTop: 160, height: 80 },
    ]
    // Unfocused, b is pushed off its line by a.
    expect(layoutThreads(items).tops.get('b')).toBeGreaterThan(128)

    const { tops } = layoutThreads(items, { focusedId: 'b' })
    // The thread being read is beside its text, exactly.
    expect(tops.get('b')).toBe(128)
    // a gives way upward rather than shoving b down…
    expect(tops.get('a')! + 80).toBe(128 - MIN_GAP)
    // …and c gives way downward.
    expect(tops.get('c')).toBe(128 + 80 + MIN_GAP)
  })

  test('threads whose anchors are off screen become counts, not cards', () => {
    const { above, below } = layoutThreads(
      [
        { id: 'a', anchorTop: -300, height: 80 },
        { id: 'b', anchorTop: 200, height: 80 },
        { id: 'c', anchorTop: 900, height: 80 },
        { id: 'd', anchorTop: 1200, height: 80 },
      ],
      { viewport: { top: 0, bottom: 600 } },
    )
    expect(above).toBe(1)
    expect(below).toBe(2)
  })
})
