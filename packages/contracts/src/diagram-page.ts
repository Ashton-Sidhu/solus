/**
 * The page a published diagram is read on.
 *
 * A Google Doc page is a fixed frame with no pan and no zoom, so a diagram is
 * published as one picture on one landscape page, drawn as large as that page
 * allows. The client fits the drawing to the page and the server sizes the
 * image on it; both read the numbers from here so they never disagree.
 */

export interface PixelSize {
  width: number
  height: number
}

/** The printable area of a landscape Letter page at 96 dpi, in CSS pixels,
 *  inside a figure page's 0.5in margins. A4 is within a few percent of it. */
export const FIGURE_PAGE: PixelSize = { width: 960, height: 720 }

/** Room under a figure for its caption paragraph and the paragraph gaps
 *  around it. A figure that takes the whole page pushes its caption onto a
 *  page of its own. */
const CAPTION_ALLOWANCE = 64

/** Room above a figure for the heading that introduces it, so a reader meets
 *  the diagram and its title on one page. A heading and its space below is
 *  about this tall at H1; smaller headings leave the slack unused. */
const HEADING_ALLOWANCE = 96

/** The part of a figure page the picture itself may fill. */
export const FIGURE_AREA: PixelSize = {
  width: FIGURE_PAGE.width,
  height: FIGURE_PAGE.height - CAPTION_ALLOWANCE - HEADING_ALLOWANCE,
}

/** The widest a diagram is drawn inside a scrolling document column. */
export const SCROLLING_FIGURE_MAX_WIDTH = 760

/** The factor a drawing of this size is placed at: it fills the figure area
 *  on whichever axis runs out first. Aspect is all this reads, so it answers
 *  the same for a canvas frame in CSS pixels and for the PNG of it. */
export function fitToPage(size: PixelSize): number {
  return Math.min(FIGURE_AREA.width / size.width, FIGURE_AREA.height / size.height)
}

/**
 * The resolution a figure is drawn for, against the inches it occupies on the
 * page. A diagram this dense is read zoomed in, and Google Docs at 200% zoom
 * on a high-density display paints the figure at four times its CSS size —
 * 384 dpi before Docs resamples anything. 500 leaves that margin, and print
 * asks for less.
 */
export const FIGURE_TARGET_DPI = 500
/** CSS pixels are 96 to the inch, which is what a page size here is measured in. */
const CSS_DPI = 96

/**
 * The ratio to rasterize a page figure at. A figure is enlarged to fill its
 * page, so the pixels have to be counted against where the figure lands, not
 * against the canvas it came from: rasterizing a small drawing at twice its
 * canvas size and then enlarging it to fill the page is how a figure ends up
 * at barely 100 dpi.
 */
export function figureRasterRatio(frame: PixelSize): number {
  return (fitToPage(frame) * FIGURE_TARGET_DPI) / CSS_DPI
}

/**
 * The resolution of a figure in a scrolling document. It keeps a small
 * drawing at its authored width and holds a wide drawing to the document
 * column. Unlike a fixed 2× capture, both cases have enough source pixels for
 * 200% zoom on a high-density display.
 */
export function scrollingFigureRasterRatio(frame: PixelSize): number {
  const displayScale = Math.min(1, SCROLLING_FIGURE_MAX_WIDTH / frame.width)
  return (displayScale * FIGURE_TARGET_DPI) / CSS_DPI
}

/**
 * Recover the width at which a scrolling document can show a PNG while it
 * still meets the figure resolution target. If the export hit its pixel
 * ceiling, the figure becomes smaller instead of becoming soft.
 */
export function scrollingFigureWidth(pngWidth: number): number {
  return Math.min(SCROLLING_FIGURE_MAX_WIDTH, (pngWidth * CSS_DPI) / FIGURE_TARGET_DPI)
}
