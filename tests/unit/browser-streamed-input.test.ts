import { describe, expect, test } from 'bun:test'
import {
  isPrintableKey,
  keepsStrokePoint,
  pointToViewport,
  rectFromDrag,
  RegionBrowserSender,
  type RegionBrowserUpdate,
} from '@solus/workspace-ui/components/browser/lib/streamed-input'
import { DEVICE_PRESETS, presetById, resolveViewport } from '@solus/contracts/browser-types'

/**
 * A streamed surface forwards a pointer at a canvas pixel, but the guest is
 * emulating a viewport at another size scaled to fit the pane. These tests
 * encode the mapping that makes a tap land where the user aimed — the whole
 * difference between light interaction that works and a click 100px off.
 */

const RECT = { left: 100, top: 50, width: 300, height: 600 }

describe('streamed surface input mapping', () => {
  test('maps a pointer from the canvas to the guest viewport, not the pane', () => {
    // WHY: the picture may be a 390px phone shown in a 300px canvas. A click at
    // the canvas centre has to become the viewport centre, in the guest's own
    // pixels, or every tap lands short.
    const viewport = resolveViewport({ mode: 'custom', width: 390, height: 780 })
    const point = pointToViewport(100 + 150, 50 + 300, RECT, viewport)

    expect(point.x).toBe(195)
    expect(point.y).toBe(390)
  })

  test('clamps a pointer that left the surface to its edges', () => {
    // WHY: a drag can slide off the canvas; the guest must still get a coordinate
    // inside its viewport rather than a negative or overshoot.
    const viewport = resolveViewport({ mode: 'custom', width: 400, height: 800 })

    expect(pointToViewport(0, 0, RECT, viewport)).toEqual({ x: 0, y: 0 })
    expect(pointToViewport(9999, 9999, RECT, viewport)).toEqual({ x: 400, y: 800 })
  })

  test('a single character is typed; a named key is pressed', () => {
    // WHY: an accented or shifted character has to arrive as itself, not as a
    // synthesized keycode — so a lone printable char is inserted, and only the
    // named keys (Enter, Backspace) go through the press path.
    expect(isPrintableKey('a')).toBe(true)
    expect(isPrintableKey('é')).toBe(true)
    expect(isPrintableKey('Enter')).toBe(false)
    expect(isPrintableKey('Backspace')).toBe(false)
  })
})

/**
 * Marking a streamed page.
 *
 * The desktop `<webview>` is drawn on directly, so the overlay in the guest sees
 * the pointer itself. A canvas cannot: a drag exists only on the client, and
 * freehand and region did not exist at all on web or mobile until it could be
 * described and handed over as one finished mark.
 */
describe('a gesture captured on a streamed surface', () => {
  test('samples the stroke in the guest coordinates, not the canvas ones', () => {
    // WHY: a phone showing a 1440px page at a third of scale would otherwise
    // sample three times as coarsely as a desktop showing it at full size, and
    // the same gesture would arrive as a different stroke on each client.
    expect(keepsStrokePoint({ x: 10, y: 10 }, { x: 12, y: 10 })).toBe(false)
    expect(keepsStrokePoint({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(true)
    expect(keepsStrokePoint({ x: 10, y: 10 }, { x: 11, y: 12 })).toBe(true)
  })

  test('reads a rectangle the same however it was dragged', () => {
    // WHY: dragging up and to the left means the same rectangle as dragging
    // down and to the right. Without normalising, half of every user's drags
    // arrive with negative dimensions and are silently dropped by the guest.
    const downRight = rectFromDrag({ x: 10, y: 20 }, { x: 60, y: 90 })
    const upLeft = rectFromDrag({ x: 60, y: 90 }, { x: 10, y: 20 })
    expect(downRight).toEqual({ x: 10, y: 20, width: 50, height: 70 })
    expect(upLeft).toEqual(downRight)
  })

  test('coalesces live box browsers and sends the commit last', async () => {
    // WHY: remote pointer moves can arrive faster than one RPC returns. The
    // latest rectangle must replace stale queued ones, while the release must
    // remain last so an older browser cannot cover the committed selection.
    const sent: RegionBrowserUpdate[] = []
    let releaseFirst: (() => void) | undefined
    const sender = new RegionBrowserSender((update) => {
      sent.push(update)
      if (sent.length !== 1) return Promise.resolve()
      return new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    })
    const first = sender.browser({ x: 10, y: 10, width: 20, height: 20 })
    void sender.browser({ x: 10, y: 10, width: 40, height: 40 })
    void sender.browser({ x: 10, y: 10, width: 60, height: 60 })
    void sender.commit({ x: 10, y: 10, width: 80, height: 80 })

    expect(sent).toEqual([
      { rect: { x: 10, y: 10, width: 20, height: 20 }, commit: false },
    ])
    releaseFirst?.()
    await first
    expect(sent).toEqual([
      { rect: { x: 10, y: 10, width: 20, height: 20 }, commit: false },
      { rect: { x: 10, y: 10, width: 80, height: 80 }, commit: true },
    ])
  })
})


describe('the device catalog', () => {
  test('carries the MacBook Pro at the size a page actually lays out against', () => {
    // WHY: 1512 × 982 is the logical resolution the machine reports at its
    // default scaling, which is what CSS sees — not the panel's pixel count.
    const preset = presetById('macbook-pro-15')
    expect(preset?.width).toBe(1512)
    expect(preset?.height).toBe(982)
    expect(preset?.group).toBe('desktop')
  })

  test('gives every preset a distinct id', () => {
    // WHY: `presetById` takes the first match, so a duplicate id makes one of
    // the two silently unreachable from the picker and from an agent verb.
    expect(new Set(DEVICE_PRESETS.map((preset) => preset.id)).size).toBe(
      DEVICE_PRESETS.length,
    )
  })
})
