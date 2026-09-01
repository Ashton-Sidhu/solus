import { describe, expect, test } from 'bun:test'
import {
  fillSize,
  fitStage,
  placeGuest,
  resizeViewport,
  PARKED_GUEST_OFFSET,
} from '@solus/workspace-ui/components/browser/lib/stage-math'
import {
  presetById,
  browserPartition,
  resolveViewport,
  viewportFor,
  BROWSER_MAX_DIMENSION,
  BROWSER_MIN_DIMENSION,
} from '@solus/contracts/browser-types'

function viewport(presetId: string, orientation: 'portrait' | 'landscape' = 'portrait') {
  const preset = presetById(presetId)
  if (!preset) throw new Error(`missing preset ${presetId}`)
  return viewportFor(preset, orientation)
}

describe('browser stage', () => {
  test('a device larger than the pane is scaled down, never narrowed', () => {
    // WHY: this is the difference between a shrunken desktop layout and a
    // tablet layout. Narrowing the guest would silently change which media
    // queries apply and make the browser a lie.
    const fit = fitStage(viewport('desktop'), 800, 600)

    expect(fit.deviceWidth).toBe(1920)
    expect(fit.deviceHeight).toBe(1080)
    expect(fit.scale).toBeLessThan(1)
    expect(fit.paintedWidth).toBeLessThanOrEqual(800)
    expect(fit.paintedHeight).toBeLessThanOrEqual(600)
  })

  test('a device that fits is shown at true CSS pixels', () => {
    // WHY: scaling up would blur a phone browser for no reason and misreport
    // what a 393px layout looks like.
    const fit = fitStage(viewport('iphone-15'), 1200, 1400)

    expect(fit.scale).toBe(1)
    expect(fit.paintedWidth).toBe(393)
    expect(fit.paintedHeight).toBe(852)
  })

  test('rotating swaps the axes the stage has to fit', () => {
    const portrait = fitStage(viewport('iphone-15'), 2000, 2000)
    const landscape = fitStage(viewport('iphone-15', 'landscape'), 2000, 2000)

    expect(landscape.deviceWidth).toBe(portrait.deviceHeight)
    expect(landscape.deviceHeight).toBe(portrait.deviceWidth)
  })

  test('a stage with no room yet reserves nothing', () => {
    // WHY: the pane measures at zero on its first frame, and the guest is
    // painted from this box in a fixed layer that no pane clips. Falling back
    // to the device's own size there put a 1512px white guest across the whole
    // window. Nothing is the only honest answer until the stage is measured.
    const fit = fitStage(viewport('laptop'), 0, 0)

    expect(fit.paintedWidth).toBe(0)
    expect(fit.paintedHeight).toBe(0)
  })

  test('a measured stage never reserves more room than it has', () => {
    // WHY: the same rule, stated where it is easy to break — every published
    // box has to fit inside the pane, because nothing downstream crops it.
    for (const [width, height] of [[400, 300], [1, 1], [900, 20]]) {
      const fit = fitStage(viewport('desktop'), width, height)

      expect(fit.paintedWidth).toBeLessThanOrEqual(width)
      expect(fit.paintedHeight).toBeLessThanOrEqual(height)
    }
  })

  test('a guest is framed by the slot, never by its own device size', () => {
    // WHY: the webview layer is fixed at app root, so no pane can crop it. The
    // frame has to be the published slot and the device scaled inside it —
    // otherwise a slot that is stale or wrong paints a device-sized rectangle
    // across the whole workspace, which is exactly what happened.
    const placement = placeGuest(viewport('desktop'), {
      left: 40,
      top: 120,
      width: 600,
      height: 338,
      layer: 'workspace',
    })

    expect(placement.width).toBe(600)
    expect(placement.height).toBe(338)
    expect(placement.scale).toBeCloseTo(600 / 1920)
    expect(placement.onScreen).toBe(true)
  })

  test('a maximized stage carries its layer to the teleported guest', () => {
    // WHY: the guest is mounted at app root, outside the fixed maximized pane.
    // Without this fact the pane background covers the page image.
    const placement = placeGuest(viewport('desktop'), {
      left: 0,
      top: 0,
      width: 1200,
      height: 675,
      layer: 'maximized',
    })

    expect(placement.layer).toBe('maximized')
  })

  test('a guest with no slot parks offscreen rather than hiding in place', () => {
    // WHY: `display: none` stops a webview rendering, and `visibility: hidden`
    // stalls the CDP commands an agent drives a parked page with. Offscreen is
    // the only park that leaves the page both invisible and answerable.
    const placement = placeGuest(viewport('iphone-15'), undefined)

    expect(placement.left).toBe(PARKED_GUEST_OFFSET)
    expect(placement.top).toBe(PARKED_GUEST_OFFSET)
    expect(placement.onScreen).toBe(false)
    expect(placement.scale).toBe(1)
  })

  test('a filling page takes the whole stage, with no letterbox', () => {
    // WHY: fill means the page is the size of the space it is shown in. Keeping
    // the letterbox padding there would make every filling page report a
    // viewport 32px narrower than the pane the user is judging it against.
    const filling = resolveViewport({ mode: 'fill', width: 900, height: 600 })
    const fit = fitStage(filling, 900, 600)

    expect(fit.scale).toBe(1)
    expect(fit.paintedWidth).toBe(900)
    expect(fit.paintedHeight).toBe(600)
  })

  test('a pane smaller than the smallest viewport stops shrinking the page', () => {
    // WHY: a collapsed pane would otherwise ask for a viewport nothing can lay
    // out in, and every request would be refused for the rest of the drag.
    expect(fillSize(20, 5)).toEqual({
      width: BROWSER_MIN_DIMENSION,
      height: BROWSER_MIN_DIMENSION,
    })
  })

  test('a dragged edge moves twice as far as the pointer, in device pixels', () => {
    // WHY: the stage is centred, so the held edge is only half the change — a
    // drag that grew the page by the pointer's travel would lag behind the
    // cursor by half the distance and never reach the edge under it.
    const start = { width: 400, height: 800 }

    expect(resizeViewport(start, { x: 30, y: 0 }, 1, 'east')).toEqual({ width: 460, height: 800 })
    // At 50%, a screen pixel is two device pixels: the page has to track the
    // pointer, not the scaled picture.
    expect(resizeViewport(start, { x: 30, y: 0 }, 0.5, 'east')).toEqual({ width: 520, height: 800 })
    expect(resizeViewport(start, { x: 30, y: 10 }, 1, 'south')).toEqual({ width: 400, height: 820 })
  })

  test('a drag cannot leave the page outside the sizes a viewport can be', () => {
    const clamped = resizeViewport({ width: 400, height: 800 }, { x: -9000, y: 9000 }, 1, 'southeast')

    expect(clamped.width).toBe(BROWSER_MIN_DIMENSION)
    expect(clamped.height).toBe(BROWSER_MAX_DIMENSION)
  })

  test('an unmeasured stage refuses to resize rather than dividing by zero', () => {
    const unchanged = resizeViewport({ width: 400, height: 800 }, { x: 50, y: 50 }, 0, 'southeast')

    expect(unchanged).toEqual({ width: 400, height: 800 })
  })

  test('the browser profile is per project, not per worktree', () => {
    // WHY: a login obtained in one branch's checkout is the login the next
    // branch needs; re-authenticating per worktree would make the multi-worktree
    // case unusable.
    const projectRoot = '/Users/dev/solus'
    expect(browserPartition(projectRoot)).toBe(browserPartition(projectRoot))
    expect(browserPartition(projectRoot)).not.toBe(browserPartition('/Users/dev/other'))
    expect(browserPartition(projectRoot)).toStartWith('persist:')
  })

  test('a target outside any repository still gets a durable profile', () => {
    expect(browserPartition(undefined)).toStartWith('persist:')
  })
})
