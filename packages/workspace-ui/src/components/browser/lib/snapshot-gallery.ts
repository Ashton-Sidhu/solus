import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import { snapshotAddress, snapshotFacts, snapshotTitle } from './snapshot-card'

/**
 * Several captures from one pass, taken apart for display.
 *
 * A capture pass that took four frames used to leave four cards stacked down the
 * transcript, each repeating the same header, the same viewport and the same
 * footer, and each pushing the agent's own sentence about them further away. The
 * pass was one act of looking; the transcript said it was four.
 *
 * So from two frames up the cards become one plate: one header, one grid of
 * equal tiles, one footer. Everything here is the arithmetic that turns a list
 * of captures into that plate — how many columns it takes, what each tile is
 * captioned with, and what the header and footer can say once for all of them.
 */

/** The plate never grows past two rows of three. Past that the transcript is
 *  being used as a filesystem, and the rest belongs in the lightbox. */
export const GALLERY_MAX_CELLS = 6

/** Below this a capture is not a gallery: one frame keeps the single-frame card
 *  with its full-width picture and its viewport stamp. */
export const GALLERY_MIN_FRAMES = 2

export interface GalleryLayout {
  /**
   * How the frames are laid out.
   *
   * `grid` — equal cells, cropped to the top of the page. Right for landscape
   * captures, where a page's own shape is near the shape of a cell and the crop
   * costs the bottom of the page rather than the sense of it.
   *
   * `rail` — frames at their true proportion, centred on the plate ground.
   * Right for portrait captures, where a cell of the same shape as a landscape
   * one would have to blow the page up past twice its size and then keep the top
   * fifth of it, which is how a phone screenshot turns into an unreadable close
   * up of a nav bar.
   */
  mode: 'grid' | 'rail'
  /** Cells per row. Also the plate's `data-columns`, which the narrow-container
   *  rule reads to fold three columns into two. Grid only. */
  columns: number
  /** Cell height in the grid, frame height on the rail. */
  tileHeight: string
}

/** The card's width at the reference size. The rail divides it, so a pass of
 *  six never has to wrap or scroll to be seen whole. */
const PLATE_REFERENCE_WIDTH = 660
/** A plate past this stops being a card in a conversation and becomes a page. */
const TALLEST_FRAME = 340
const ROOT_FONT_SIZE = 16

function rem(px: number): string {
  return `${Math.round((px / ROOT_FONT_SIZE) * 1000) / 1000}rem`
}

/**
 * The shape the plate takes, from how many frames there are and what shape they
 * are.
 *
 * Three rules fight here. A tile below a third of the card is a thumbnail nobody
 * can recognise a page from, so the column count stops at three. A plate taller
 * than about two rows becomes a page of its own, so cells shorten as rows go up.
 * And a frame blown up past its own size is worse than a small one — it is the
 * same pixels, bigger and blurrier, cropped to whatever the cell had room for.
 * The last rule is why portrait captures leave the grid entirely.
 */
export function galleryLayout(count: number, aspect: number): GalleryLayout {
  const frames = Math.min(count, GALLERY_MAX_CELLS)
  if (aspect < 1) {
    // Tall frames stay on one row and give up height as the pass grows, so the
    // row always fits the card and every frame keeps its own proportion.
    const height = Math.min(TALLEST_FRAME, PLATE_REFERENCE_WIDTH / frames / aspect)
    return { mode: 'rail', columns: frames, tileHeight: rem(height) }
  }
  if (count <= 2) return { mode: 'grid', columns: 2, tileHeight: '12.5rem' }
  if (count === 3) return { mode: 'grid', columns: 3, tileHeight: '9.875rem' }
  if (count === 4) return { mode: 'grid', columns: 2, tileHeight: '9.875rem' }
  return { mode: 'grid', columns: 3, tileHeight: '8.25rem' }
}

/**
 * The shape the plate and the reel are cut to: the pass's own, since a pass is
 * nearly always one device. A mixed pass follows its first frame.
 *
 * This reads the viewport's true proportion rather than the single-frame card's
 * clamped one. That card's floor of 0.5 is there to stop one extreme capture
 * making a card nobody can read the caption of — but a phone is 0.46, so
 * borrowing that floor would squeeze every phone frame by eight per cent and
 * quietly crop the sides off it. The floor here is below every phone and still
 * refuses a full-page capture that is ten screens long.
 */
const NARROWEST_FRAME = 0.4
const WIDEST_FRAME = 3

export function galleryAspect(snapshots: BrowserSnapshotRef[]): number {
  const facts = snapshotFacts(snapshots[0])
  const [width, height] = facts.size.split('×').map((part) => Number.parseInt(part, 10))
  if (!width || !height) return Number.parseFloat(facts.aspectRatio)
  return Math.min(Math.max(width / height, NARROWEST_FRAME), WIDEST_FRAME)
}

/**
 * What the tiles are captioned with.
 *
 * A caption repeated identically on six tiles is six times nothing. Which fact
 * distinguishes the frames is a property of the set, not of any one frame, so it
 * is decided once for the whole plate: different pages caption by page, one page
 * at several widths captions by width, and a set that shares both is a sequence
 * and captions by position.
 */
export type GalleryCaptionMode = 'page' | 'width' | 'index'

export function galleryCaptionMode(snapshots: BrowserSnapshotRef[]): GalleryCaptionMode {
  const pages = new Set(snapshots.map((snapshot) => snapshot.url))
  if (pages.size > 1) return 'page'
  const viewports = new Set(snapshots.map((snapshot) => snapshot.viewport))
  return viewports.size > 1 ? 'width' : 'index'
}

export interface GalleryTile {
  snapshot: BrowserSnapshotRef
  /** The tile's own name — a page title, or nothing when the plate captions by
   *  width or position and a name would be the same word six times. */
  label: string
  /** The mono half of the caption: the path, the width, or `3 / 7`. */
  detail: string
  /**
   * How many frames this tile stands for beyond itself, or 0 for an ordinary
   * tile. Only the last cell of a capped plate is ever more than one frame.
   */
  overflow: number
  /** What a reader of the tile is told they are opening. */
  alt: string
}

export function galleryTiles(snapshots: BrowserSnapshotRef[]): GalleryTile[] {
  const mode = galleryCaptionMode(snapshots)
  const shown = Math.min(snapshots.length, GALLERY_MAX_CELLS)
  const lastCellIndex = shown - 1
  return snapshots.slice(0, shown).map((snapshot, index) => ({
    snapshot,
    label: mode === 'page' ? snapshotTitle(snapshot) : '',
    detail: tileDetail(snapshot, mode, index, snapshots.length),
    // The capped plate's last cell is the frame it would have shown anyway,
    // counted with everything it displaced — so the header's total and the
    // cells always add up, and the tile still opens the reel at its own frame.
    overflow: snapshots.length > GALLERY_MAX_CELLS && index === lastCellIndex
      ? snapshots.length - lastCellIndex
      : 0,
    alt: snapshotTitle(snapshot),
  }))
}

function tileDetail(
  snapshot: BrowserSnapshotRef,
  mode: GalleryCaptionMode,
  index: number,
  total: number,
): string {
  if (mode === 'index') return `${index + 1} / ${total}`
  if (mode === 'width') return snapshotFacts(snapshot).size.split('×')[0] ?? snapshot.viewport
  try {
    return `${new URL(snapshot.url).pathname}`
  } catch {
    return snapshot.url
  }
}

/** The header's count. The true total, never the number of cells — a plate that
 *  capped at six still looked at nine pages and has to say so. */
export function galleryHeading(snapshots: BrowserSnapshotRef[]): string {
  return `${snapshots.length} snapshots`
}

/**
 * The facts the whole plate shares, stated once beside the count.
 *
 * A frame is only evidence with its viewport and colour scheme attached. When
 * every frame was taken the same way the header carries them for all of them and
 * the tiles stay clean; when they differ the header says nothing and each tile's
 * own caption is the only honest place for it.
 */
export function gallerySubject(snapshots: BrowserSnapshotRef[]): string {
  const viewports = new Set(snapshots.map((snapshot) => snapshot.viewport))
  const appearances = new Set(snapshots.map((snapshot) => snapshot.appearance))
  if (viewports.size > 1) return ''
  const facts = snapshotFacts(snapshots[0])
  const viewport = [facts.device, facts.size].filter(Boolean).join(' · ')
  if (appearances.size > 1 || snapshots[0].appearance === 'system') return viewport
  return `${viewport} · ${snapshots[0].appearance}`
}

/**
 * The footer's address line.
 *
 * Two worktrees serving the same app differ only by port, so the host is the one
 * thing that says which of them the agent was looking at. Past that the reader
 * wants the extent of the pass — how many distinct pages it covered — not six
 * addresses they cannot read at this size.
 */
export function galleryAddress(snapshots: BrowserSnapshotRef[]): string {
  const pages = new Set(snapshots.map((snapshot) => snapshot.url))
  if (pages.size === 1) return snapshotAddress(snapshots[0])
  const hosts = new Set(snapshots.map((snapshot) => hostOf(snapshot.url)))
  const extent = `${pages.size} pages`
  return hosts.size === 1 ? `${[...hosts][0]} · ${extent}` : extent
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The console errors the pass turned up, summed.
 *
 * A page can look correct and be broken, and that stays the one fact the picture
 * cannot carry. Per tile it would be a badge too small to read on a frame too
 * small to place it on, so the plate reports the pass's total and the lightbox
 * attributes it to a frame.
 */
export function galleryErrorLabel(snapshots: BrowserSnapshotRef[]): string | null {
  const total = snapshots.reduce((sum, snapshot) => sum + snapshot.consoleErrors, 0)
  if (total <= 0) return null
  return `${total} console error${total === 1 ? '' : 's'}`
}

/**
 * Whether a frame of the reel is close enough to the visible one to be worth
 * fetching.
 *
 * The reel keeps every frame mounted, because the carousel measures all of them
 * to know where a drag lands. Fetching all of them is a different matter: each
 * picture is a full-page PNG pulled from the asset store, so mounting nine
 * images at once would turn opening one capture into nine downloads. Only the
 * visible frame and the two a step away are fetched — which is exactly what a
 * step or a swipe can reach before the next fetch starts — and the reel wraps,
 * so the last frame neighbours the first.
 */
export function isFrameNear(index: number, selected: number, total: number): boolean {
  if (total <= 3) return true
  const distance = Math.abs(index - selected)
  return Math.min(distance, total - distance) <= 1
}

/**
 * Whether a frame is worth fetching for the filmstrip under the reel.
 *
 * The strip shows the whole pass, which reads like the opposite of the rule
 * above — but the plate the reader just clicked is still mounted behind the
 * reel, and it already fetched its own cells. Those thumbnails are already in
 * hand and cost nothing to show. Only the frames the plate capped away are new,
 * and those follow the reel's own window, filling in as the reader steps.
 */
export function isStripFrameNear(index: number, selected: number, total: number): boolean {
  return index < GALLERY_MAX_CELLS || isFrameNear(index, selected, total)
}

/**
 * Whether the plate's footer can act.
 *
 * Annotate and Open in pane name one page. A plate spanning several pages has no
 * single page to name, and a button that silently picks the first frame is worse
 * than no button — there the tiles are the way in and the lightbox carries the
 * per-frame way back.
 */
export function gallerySharedPageId(snapshots: BrowserSnapshotRef[]): string | null {
  const pages = new Set(snapshots.map((snapshot) => snapshot.browserPageId))
  return pages.size === 1 ? snapshots[0].browserPageId : null
}
