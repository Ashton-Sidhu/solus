import { describe, expect, test } from 'bun:test'
import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import {
  galleryAddress,
  galleryCaptionMode,
  galleryErrorLabel,
  galleryHeading,
  gallerySharedPageId,
  gallerySubject,
  galleryTarget,
  galleryAspect,
  galleryTiles,
  isFrameNear,
} from '@solus/workspace-ui/components/browser/lib/snapshot-gallery'
import { snapshotWidth } from '@solus/workspace-ui/components/browser/lib/snapshot-card'

function snapshot(overrides: Partial<BrowserSnapshotRef> = {}): BrowserSnapshotRef {
  return {
    browserPageId: 'browser_1',
    assetId: 'a'.repeat(64) + '.png',
    url: 'http://solus.sh/',
    title: 'Solus',
    viewport: 'Laptop — 1440×900',
    appearance: 'light',
    elementCount: 0,
    consoleErrors: 0,
    capturedAt: 1,
    ...overrides,
  }
}

/** A pass of `count` frames over distinct pages, as a browser_open sweep makes. */
function pass(count: number): BrowserSnapshotRef[] {
  return Array.from({ length: count }, (_, index) =>
    snapshot({
      assetId: `${index}`.repeat(8) + '.png',
      browserPageId: `browser_${index}`,
      url: `http://solus.sh/page-${index}`,
      title: `Page ${index}`,
    }),
  )
}

/** A landscape capture. */
const WIDE = 1440 / 900
/** An iPhone 15. */
const TALL = 393 / 852

describe('the shape each frame is drawn at', () => {
  test("reads each frame's shape from its own viewport, so nothing is cropped", () => {
    // WHY: a frame forced into another shape is either cropped or letterboxed,
    // and a cropped capture is one the reader has to open before they can read
    // it — the reason the pictures render inline at all.
    const mixed = [
      snapshot({ viewport: 'Laptop — 1440×900', assetId: 'a.png' }),
      snapshot({ viewport: 'iPhone 15 — 393×852', assetId: 'b.png' }),
    ]
    const aspects = galleryTiles(mixed).map((tile) => tile.aspect)
    expect(aspects[0]).toBeCloseTo(WIDE, 3)
    expect(aspects[1]).toBeCloseTo(TALL, 3)
  })

  test('shows every frame of a long pass, so the row and its count agree', () => {
    // WHY: the row scrolls sideways, so there is no cell budget to fold frames
    // into. A row that hid some would contradict the count on its own line.
    expect(galleryTiles(pass(9))).toHaveLength(9)
    expect(galleryHeading(pass(9))).toBe('9 snapshots')
  })

  test('calls one capture a snapshot rather than counting it', () => {
    expect(galleryHeading(pass(1))).toBe('Snapshot')
  })

  test('refuses a full-page capture ten screens long', () => {
    // WHY: an unclamped shape would draw a frame as tall as the page it
    // scrolled, a sliver at the row's height.
    expect(galleryTiles([snapshot({ viewport: 'Full page — 1440×9000' })])[0]?.aspect)
      .toBeGreaterThanOrEqual(0.4)
  })

  test("reads the pass's shape from its frames, not from a guess", () => {
    expect(galleryAspect([snapshot({ viewport: 'iPhone 15 — 393×852' })]))
      .toBeCloseTo(TALL, 3)
    expect(galleryAspect(pass(2))).toBeCloseTo(WIDE, 3)
  })
})

describe('what the frames are captioned with', () => {
  test('captions by page when the pass covered several', () => {
    const tiles = galleryTiles(pass(3))
    expect(galleryCaptionMode(pass(3))).toBe('page')
    expect(tiles[0]?.label).toBe('Page 0')
    expect(tiles[0]?.detail).toBe('/page-0')
  })

  test('captions by width when one page was captured at several sizes', () => {
    // WHY: repeating the same page title on three frames is three times nothing.
    // Which fact distinguishes the frames is a property of the set, so it is
    // decided once for the row rather than per frame.
    const widths = [
      snapshot({ viewport: 'iPhone 15 — 390×844', assetId: 'a.png' }),
      snapshot({ viewport: 'iPad — 834×1112', assetId: 'b.png' }),
      snapshot({ viewport: 'Laptop — 1440×900', assetId: 'c.png' }),
    ]
    expect(galleryCaptionMode(widths)).toBe('width')
    expect(galleryTiles(widths).map((tile) => tile.detail)).toEqual(['390', '834', '1440'])
    expect(galleryTiles(widths).every((tile) => tile.label === '')).toBe(true)
  })

  test('captions by position when the frames share both page and viewport', () => {
    // WHY: a before/after of the same page at the same size is a sequence, and
    // position is the only thing that tells one frame from the next.
    const repeats = [snapshot({ assetId: 'a.png' }), snapshot({ assetId: 'b.png' })]
    expect(galleryCaptionMode(repeats)).toBe('index')
    expect(galleryTiles(repeats).map((tile) => tile.detail)).toEqual(['1 / 2', '2 / 2'])
  })
})

describe('what the line says once for all of the frames', () => {
  test('carries the shared viewport and colour scheme in the header', () => {
    // WHY: a frame is only evidence with its viewport and colour scheme
    // attached. When every frame was taken the same way the header carries them
    // for all of them and the captions stay clean.
    expect(gallerySubject(pass(3))).toBe('Laptop · 1440×900 · light')
  })

  test('says nothing when the frames were not taken the same way', () => {
    // WHY: a header stating one viewport over frames taken at three would be a
    // lie about the evidence, and each frame's caption is the honest place.
    const mixed = [
      snapshot({ viewport: 'iPhone 15 — 390×844', assetId: 'a.png' }),
      snapshot({ viewport: 'Laptop — 1440×900', assetId: 'b.png' }),
    ]
    expect(gallerySubject(mixed)).toBe('')
  })

  test('states the origin and the extent of the pass on the card line', () => {
    // WHY: two worktrees serving the same app differ only by port, so the host
    // is the one thing that says which of them the agent was looking at. Past
    // that the reader wants the extent, not six unreadable addresses.
    expect(galleryAddress(pass(3))).toBe('solus.sh · 3 pages')
    expect(galleryAddress([snapshot(), snapshot()])).toBe('solus.sh/')
    const hosts = [
      snapshot({ url: 'http://localhost:5176/demo/', assetId: 'a.png' }),
      snapshot({ url: 'http://localhost:5185/demo/', assetId: 'b.png' }),
    ]
    expect(galleryAddress(hosts)).toBe('2 pages')
  })

  test('puts where the pass looked before what its frames share, in one slot', () => {
    // WHY: the address and the shared viewport share
    // the line's one truncating slot. Where it looked comes first, as it is the
    // fact that tells two worktrees apart; an empty subject adds no separator.
    expect(galleryTarget([snapshot(), snapshot()])).toBe('solus.sh/ · Laptop · 1440×900 · light')
    const mixed = [
      snapshot({ viewport: 'iPhone 15 — 390×844', assetId: 'a.png' }),
      snapshot({ viewport: 'Laptop — 1440×900', assetId: 'b.png' }),
    ]
    expect(galleryTarget(mixed)).toBe('solus.sh/')
  })

  test('sums the console errors of the pass, and stays silent at zero', () => {
    // WHY: a page can look correct and be broken. The line reports the pass's
    // total, and a badge that is always there teaches people to stop reading it.
    const noisy = [
      snapshot({ consoleErrors: 1, assetId: 'a.png' }),
      snapshot({ consoleErrors: 2, assetId: 'b.png' }),
    ]
    expect(galleryErrorLabel(noisy)).toBe('3 console errors')
    expect(galleryErrorLabel(pass(3))).toBeNull()
  })

  test('offers Annotate and Open only when there is one page to act on', () => {
    // WHY: Annotate and Open in pane name one page. A button that silently
    // picked the first frame of a multi-page pass would send the reader
    // somewhere they did not click.
    expect(gallerySharedPageId([snapshot(), snapshot()])).toBe('browser_1')
    expect(gallerySharedPageId(pass(3))).toBeNull()
  })
})

describe('what the reel is willing to download', () => {
  test('fetches the visible frame and its two neighbours, not the whole pass', () => {
    // WHY: the carousel measures every slide, so all of them stay mounted — but
    // each picture is a full-page PNG pulled from the asset store, and fetching
    // them all would turn opening one capture into nine downloads.
    expect(isFrameNear(0, 0, 9)).toBe(true)
    expect(isFrameNear(1, 0, 9)).toBe(true)
    expect(isFrameNear(2, 0, 9)).toBe(false)
    expect(isFrameNear(5, 0, 9)).toBe(false)
  })

  test('wraps, because the reel does', () => {
    // WHY: the last frame is one left-arrow from the first. Fetching only
    // forwards would make exactly one direction of travel show a blank frame.
    expect(isFrameNear(8, 0, 9)).toBe(true)
    expect(isFrameNear(0, 8, 9)).toBe(true)
  })

  test('keeps a short pass whole, where windowing would cost a fetch and save none', () => {
    expect([0, 1, 2].every((index) => isFrameNear(index, 0, 3))).toBe(true)
  })

})

describe('what a frame click opens', () => {
  test('zooms to the page’s own width, not the file’s', () => {
    // WHY: a capture is taken at the display's pixel ratio, so the PNG is
    // commonly twice the page. "Actual size" read off the file is a magnifying
    // glass that lies about what the browser drew.
    expect(snapshotWidth(snapshot({ viewport: 'Laptop — 1440×900' }))).toBe(1440)
  })
})
