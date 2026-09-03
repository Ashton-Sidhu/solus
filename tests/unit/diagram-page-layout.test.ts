import { describe, expect, test } from 'bun:test'
import {
  figureRasterRatio,
  fitToPage,
  FIGURE_AREA,
  FIGURE_PAGE,
  scrollingFigureRasterRatio,
  scrollingFigureWidth,
} from '@solus/contracts/diagram-page'
import { parseDiagram } from '@solus/contracts/diagram-types'
import type { NodeSize } from '@solus/contracts/diagram-layout'
import { exportPixelRatio } from '@solus/workspace-ui/components/diagram/lib/diagram-export'
import { printLayoutCandidates } from '@solus/workspace-ui/components/diagram/lib/page-layout'

const CONTENT = JSON.stringify({
  nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
  edges: [
    { id: 'ab', source: 'a', target: 'b', label: 'a very long label that spreads the ranks apart' },
    { id: 'bc', source: 'b', target: 'c' },
  ],
})

function axes(candidate: string) {
  const nodes = parseDiagram(candidate).nodes
  expect(nodes.every((node) => node.position)).toBe(true)
  return {
    xs: new Set(nodes.map((node) => Math.round(node.position!.x))).size,
    ys: new Set(nodes.map((node) => Math.round(node.position!.y))).size,
  }
}

describe('print layout candidates', () => {
  test('a diagram is re-laid out for print in both flow directions', () => {
    // WHY: a left-to-right graph with long edge labels can be many pages wide;
    // stacking its ranks, or packing them, is what can make it fit a page.
    const [stacked, packed] = printLayoutCandidates(CONTENT, new Map())
    expect(axes(stacked)).toEqual({ xs: 1, ys: 3 })
    expect(axes(packed)).toEqual({ xs: 3, ys: 1 })
  })

  test('cards are placed at the width the canvas measured, not the estimate', () => {
    // WHY: the estimate reads the label but not the subtitle, so a real card
    // can be ~90px wider than predicted. Print spacing is tight enough that
    // laying out from the estimate overlaps two cards on the page.
    const measured = new Map<string, NodeSize>([
      ['a', { w: 288, h: 56 }],
      ['b', { w: 288, h: 56 }],
      ['c', { w: 288, h: 56 }],
    ])
    const [, packed] = printLayoutCandidates(CONTENT, measured)
    const nodes = parseDiagram(packed).nodes
    const [a, b] = [nodes[0], nodes[1]]
    // Ranks run left to right: 288px cards, 64px apart.
    expect(b.position!.x - a.position!.x).toBeGreaterThanOrEqual(288)
  })

  test('print spacing packs ranks tighter than the canvas does', () => {
    const content = JSON.stringify({
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ id: 'ab', source: 'a', target: 'b' }],
    })
    const [stacked] = printLayoutCandidates(content, new Map())
    const [a, b] = parseDiagram(stacked).nodes
    // 56 px tall cards 64 px apart: the canvas would leave 140 px.
    expect(b.position!.y - a.position!.y).toBe(56 + 64)
  })

  test('unreadable content offers no re-layout, so the authored drawing stands', () => {
    expect(printLayoutCandidates('not json', new Map())).toEqual([])
  })
})

describe('page fit', () => {
  test('a drawing fills the figure area on whichever axis runs out first', () => {
    // WHY: the page is the diagram's whole allowance and there is no second
    // page to spill onto, so the figure takes all of it. 960×560 is the area:
    // the landscape page less the caption's room and the heading's.
    expect(fitToPage({ width: 1920, height: 1000 })).toBe(0.5)
    expect(fitToPage({ width: 1000, height: 1120 })).toBe(0.5)
    expect(fitToPage({ width: 480, height: 280 })).toBe(2)
  })

  test('the figure area keeps the heading and the caption on the page with the figure', () => {
    // WHY: a heading left on the previous page means the reader meets the
    // drawing with nothing naming it. A figure that took the whole page is
    // what pushed it off, so the area is the page less both allowances.
    expect(FIGURE_PAGE.height - FIGURE_AREA.height).toBe(160)
    // Reserving that room is free for a wide drawing, which the page bounds
    // by width — the case every architecture diagram falls into.
    expect(fitToPage({ width: 1964, height: 962 })).toBeCloseTo(0.489, 3)
  })

  test('a figure is rasterized for where it lands, at the resolution a 200% zoom asks for', () => {
    // WHY: rasterizing at a fixed 2× the canvas and then enlarging the figure
    // to fill the page is how a small diagram reached the page at ~105 dpi.
    // Docs at 200% zoom on a high-density display paints a figure at 4× its
    // CSS size — 384 dpi — so the target has to clear that with margin.
    const placedDpi = (frame: { width: number; height: number }) => {
      const png = frame.width * figureRasterRatio(frame)
      const placedInches = (frame.width * fitToPage(frame)) / 96
      return png / placedInches
    }
    expect(placedDpi({ width: 480, height: 280 })).toBeCloseTo(500, 6)
    expect(placedDpi({ width: 3000, height: 1500 })).toBeCloseTo(500, 6)
    expect(placedDpi({ width: 480, height: 280 })).toBeGreaterThan(96 * 4)
    // A drawing the page enlarges asks for more than the 2× a canvas capture
    // uses; one the page shrinks asks for less, and the export's own floor
    // keeps that at 2×.
    expect(figureRasterRatio({ width: 480, height: 280 })).toBeCloseTo(10.4, 1)
    expect(figureRasterRatio({ width: 3000, height: 1500 })).toBeLessThan(2)
  })

  test('a scrolling figure keeps the same zoom resolution at authored and column width', () => {
    // WHY: Confluence used a fixed 2× capture. That is only 192 dpi for a
    // small diagram and becomes soft at 150–200% zoom on a dense display.
    const placedDpi = (frame: { width: number; height: number }) => {
      const pngWidth = frame.width * scrollingFigureRasterRatio(frame)
      return pngWidth / (scrollingFigureWidth(pngWidth) / 96)
    }

    expect(scrollingFigureWidth(400 * scrollingFigureRasterRatio({ width: 400, height: 300 }))).toBeCloseTo(400, 6)
    expect(scrollingFigureWidth(2000 * scrollingFigureRasterRatio({ width: 2000, height: 1000 }))).toBe(760)
    expect(placedDpi({ width: 400, height: 300 })).toBeCloseTo(500, 6)
    expect(placedDpi({ width: 2000, height: 1000 })).toBeCloseTo(500, 6)
  })

  test('a scrolling figure becomes smaller when the raster ceiling prevents the target resolution', () => {
    // WHY: a tall attachment must not fill the Confluence column with too few
    // source pixels. A smaller crisp figure is safer than a soft full-width
    // one, and the full attachment still opens at its original resolution.
    const frame = { width: 1000, height: 2000 }
    const ratio = exportPixelRatio(frame.width, frame.height, scrollingFigureRasterRatio(frame))
    const pngWidth = frame.width * ratio
    const placedWidth = scrollingFigureWidth(pngWidth)

    expect(placedWidth).toBeLessThan(760)
    expect(pngWidth / (placedWidth / 96)).toBeCloseTo(500, 6)
  })
})
