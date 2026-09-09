import { describe, expect, test } from 'bun:test'
import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import {
  GALLERY_MAX_CELLS,
  galleryAddress,
  galleryCaptionMode,
  galleryErrorLabel,
  galleryHeading,
  galleryLayout,
  gallerySharedPageId,
  gallerySubject,
  galleryAspect,
  galleryTiles,
  isFrameNear,
  isStripFrameNear,
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

/** A landscape capture — the shape the spec's own grid table was drawn for. */
const WIDE = 1440 / 900
/** An iPhone 15. The shape that broke the grid: forced into a landscape cell it
 *  has to be blown up past 2× and then cropped to its top fifth. */
const TALL = 393 / 852

describe('how many cells a pass takes', () => {
  test('stops at three columns, so a tile is never below a third of the card', () => {
    // WHY: a tile narrower than that is a thumbnail nobody can recognise a page
    // from, which defeats the only reason to show six frames at once.
    for (const count of [2, 3, 4, 5, 6, 9]) {
      expect(galleryLayout(count, WIDE).columns).toBeLessThanOrEqual(3)
    }
    expect(galleryLayout(3, WIDE).columns).toBe(3)
  })

  test('squares four frames rather than leaving a row of one', () => {
    // WHY: 3 + 1 puts a lone tile on its own row at full width, which reads as
    // a failed layout rather than as a sheet.
    expect(galleryLayout(4, WIDE).columns).toBe(2)
  })

  test('shortens the tiles as the rows go up, so the plate stays a card', () => {
    // WHY: a plate taller than about two rows stops being a card in a
    // conversation and becomes a page of its own — everything past that belongs
    // in the lightbox, not in the transcript.
    const heights = [2, 3, 5].map((count) =>
      Number.parseFloat(galleryLayout(count, WIDE).tileHeight),
    )
    expect(heights[0]).toBeGreaterThan(heights[1])
    expect(heights[1]).toBeGreaterThan(heights[2])
  })

  test('caps at six cells and folds the remainder into the last one', () => {
    // WHY: the header's count is the true total, so the cells have to add up to
    // it — an overflow tile that counted only the frames it hid would leave the
    // reader with a plate that contradicts its own heading.
    const tiles = galleryTiles(pass(9))
    expect(tiles).toHaveLength(GALLERY_MAX_CELLS)
    expect(tiles.at(-1)?.overflow).toBe(4)
    expect(tiles.slice(0, -1).every((tile) => tile.overflow === 0)).toBe(true)
    expect(galleryHeading(pass(9))).toBe('9 snapshots')
  })

  test('leaves an exactly-full plate without an overflow tile', () => {
    expect(galleryTiles(pass(6)).at(-1)?.overflow).toBe(0)
  })
})

describe('a pass of phone captures', () => {
  test('leaves the grid, because a tall page cannot fill a wide cell honestly', () => {
    // WHY: this is the bug the rail exists for. A 393×852 capture stretched to
    // the width of a landscape cell is scaled past 2×, and a cell that short
    // then keeps only the top fifth of it — so the reader gets a blurry
    // close-up of a nav bar and cannot tell which page they are looking at.
    expect(galleryLayout(2, TALL).mode).toBe('rail')
    expect(galleryLayout(2, WIDE).mode).toBe('grid')
  })

  test('keeps every frame on one row, whatever the pass cost', () => {
    // WHY: the rail's whole claim is that you can see the pass at a glance. A
    // second row of tall frames would push the plate past the height at which
    // it is still a card in a conversation.
    for (const count of [2, 3, 4, 5, 6, 9]) {
      expect(galleryLayout(count, TALL).mode).toBe('rail')
      expect(galleryLayout(count, TALL).columns).toBeLessThanOrEqual(6)
    }
  })

  test('gives up height as the pass grows, so the row always fits the card', () => {
    // WHY: six phone frames at the height two of them get would be nearly a
    // metre of card. The frames shrink instead of wrapping or scrolling.
    const REFERENCE_CARD = 660
    for (const count of [2, 3, 4, 5, 6]) {
      const height = Number.parseFloat(galleryLayout(count, TALL).tileHeight) * 16
      expect(height * TALL * count).toBeLessThanOrEqual(REFERENCE_CARD + 1)
    }
  })

  test('never lets the plate grow past a card', () => {
    // WHY: past this a plate stops being something in a conversation and
    // becomes a page, which is what the reel is for.
    for (const count of [2, 3, 4, 5, 6]) {
      expect(Number.parseFloat(galleryLayout(count, TALL).tileHeight) * 16)
        .toBeLessThanOrEqual(340)
    }
  })

  test("reads the pass's shape from its frames, not from a guess", () => {
    expect(galleryAspect([snapshot({ viewport: 'iPhone 15 — 393×852' })]))
      .toBeCloseTo(TALL, 3)
    expect(galleryAspect(pass(2))).toBeCloseTo(WIDE, 3)
  })
})

describe('what the tiles are captioned with', () => {
  test('captions by page when the pass covered several', () => {
    const tiles = galleryTiles(pass(3))
    expect(galleryCaptionMode(pass(3))).toBe('page')
    expect(tiles[0]?.label).toBe('Page 0')
    expect(tiles[0]?.detail).toBe('/page-0')
  })

  test('captions by width when one page was captured at several sizes', () => {
    // WHY: repeating the same page title on three tiles is three times nothing.
    // Which fact distinguishes the frames is a property of the set, so it is
    // decided once for the plate rather than per tile.
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

describe('what the plate says once for all of its frames', () => {
  test('carries the shared viewport and colour scheme in the header', () => {
    // WHY: a frame is only evidence with its viewport and colour scheme
    // attached. When every frame was taken the same way the header carries them
    // for all of them and the tiles stay clean.
    expect(gallerySubject(pass(3))).toBe('Laptop · 1440×900 · light')
  })

  test('says nothing when the frames were not taken the same way', () => {
    // WHY: a header stating one viewport over frames taken at three would be a
    // lie about the evidence, and each tile's caption is the honest place.
    const mixed = [
      snapshot({ viewport: 'iPhone 15 — 390×844', assetId: 'a.png' }),
      snapshot({ viewport: 'Laptop — 1440×900', assetId: 'b.png' }),
    ]
    expect(gallerySubject(mixed)).toBe('')
  })

  test('states the origin and the extent of the pass in the footer', () => {
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

  test('sums the console errors of the pass, and stays silent at zero', () => {
    // WHY: a page can look correct and be broken. Per tile the count would be a
    // badge too small to read on a frame too small to place it on, and a badge
    // that is always there teaches people to stop reading it.
    const noisy = [
      snapshot({ consoleErrors: 1, assetId: 'a.png' }),
      snapshot({ consoleErrors: 2, assetId: 'b.png' }),
    ]
    expect(galleryErrorLabel(noisy)).toBe('3 console errors')
    expect(galleryErrorLabel(pass(3))).toBeNull()
  })

  test('offers the footer actions only when there is one page to act on', () => {
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

  test('shows the filmstrip every frame the plate behind it already fetched', () => {
    // WHY: the strip's job is to keep the pass a set, and a strip of empty
    // washes cannot do it. The plate is still mounted behind the reel and paid
    // for its own cells, so those thumbnails are already in hand.
    expect([0, 1, 2, 3, 4, 5].every((index) => isStripFrameNear(index, 0, 9))).toBe(true)
  })

  test('makes the frames the plate capped away wait their turn, as the reel does', () => {
    // WHY: past the cap the strip would be asking for downloads the transcript
    // never made. Those cells fill in as the reader steps onto them.
    expect(isStripFrameNear(7, 0, 9)).toBe(false)
    expect(isStripFrameNear(7, 6, 9)).toBe(true)
  })
})

describe('what a tile click opens', () => {
  test('zooms to the page’s own width, not the file’s', () => {
    // WHY: a capture is taken at the display's pixel ratio, so the PNG is
    // commonly twice the page. "Actual size" read off the file is a magnifying
    // glass that lies about what the browser drew.
    expect(snapshotWidth(snapshot({ viewport: 'Laptop — 1440×900' }))).toBe(1440)
  })
})
