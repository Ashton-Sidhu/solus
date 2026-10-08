import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import { snapshotAddress, snapshotFacts, snapshotTitle } from './snapshot-card'

/**
 * Captures from one pass, taken apart for display.
 *
 * A pass shows inline in the transcript, as the pictures themselves: one capture
 * is one image at its own shape, and several are one row of images at a shared
 * height, each at its own shape, that scrolls sideways. No frame is cropped to
 * fit a cell, because a cropped capture is one the reader has to open to read.
 * Everything here is what the row and its one line of facts say about the pass.
 */

/**
 * The shape the reel is cut to: the pass's own, since a pass is nearly always
 * one device. A mixed pass follows its first frame.
 *
 * This reads the viewport's true proportion, clamped. The floor is below every
 * phone (an iPhone 15 is 0.46) and still refuses a full-page capture that is ten
 * screens long.
 */
const NARROWEST_FRAME = 0.4
const WIDEST_FRAME = 3

export function galleryAspect(snapshots: BrowserSnapshotRef[]): number {
  return clampedAspect(snapshots[0])
}

function clampedAspect(snapshot: BrowserSnapshotRef): number {
  const aspect = frameAspect(snapshot)
  if (aspect === null) return Number.parseFloat(snapshotFacts(snapshot).aspectRatio)
  return Math.min(Math.max(aspect, NARROWEST_FRAME), WIDEST_FRAME)
}

/** Width over height of the captured viewport, or null when its size is unknown. */
function frameAspect(snapshot: BrowserSnapshotRef): number | null {
  const [width, height] = snapshotFacts(snapshot).size.split('×').map((part) => Number.parseInt(part, 10))
  return width && height ? width / height : null
}

/**
 * What the frames of a row are captioned with.
 *
 * A caption repeated identically under six frames is six times nothing. Which
 * fact distinguishes the frames is a property of the set, not of any one frame,
 * so it is decided once for the whole row: different pages caption by page, one page
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
  /** The frame's own name — a page title, or nothing when the row captions by
   *  width or position and a name would be the same word six times. */
  label: string
  /** The mono half of the caption: the path, the width, or `3 / 7`. */
  detail: string
  /** What a reader of the frame is told they are opening. */
  alt: string
  /** Width over height of the capture, clamped. The frame is drawn at this
   *  shape, so the picture is never cropped or letterboxed to fit it. */
  aspect: number
}

export function galleryTiles(snapshots: BrowserSnapshotRef[]): GalleryTile[] {
  const mode = galleryCaptionMode(snapshots)
  return snapshots.map((snapshot, index) => ({
    snapshot,
    label: mode === 'page' ? snapshotTitle(snapshot) : '',
    detail: tileDetail(snapshot, mode, index, snapshots.length),
    alt: snapshotTitle(snapshot),
    aspect: clampedAspect(snapshot),
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

/** The line's title: one capture is a snapshot, several are counted. */
export function galleryHeading(snapshots: BrowserSnapshotRef[]): string {
  return snapshots.length === 1 ? 'Snapshot' : `${snapshots.length} snapshots`
}

/**
 * The facts the whole pass shares, stated once on its line.
 *
 * A frame is only evidence with its viewport and colour scheme attached. When
 * every frame was taken the same way the line carries them for all of them and
 * the captions stay clean; when they differ the line says nothing and each
 * frame's own caption is the only honest place for it.
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
 * Where the pass looked, for its line.
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

/**
 * The line's target: where the pass looked, then what it shares. The two
 * sit in one slot so the line truncates them together, from the end.
 */
export function galleryTarget(snapshots: BrowserSnapshotRef[]): string {
  return [galleryAddress(snapshots), gallerySubject(snapshots)].filter(Boolean).join(' · ')
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
 * cannot carry. The line reports the pass's total and the lightbox attributes it
 * to a frame.
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
 * Whether the line can offer Annotate and Open.
 *
 * Annotate and Open in pane name one page. A pass spanning several pages has no
 * single page to name, and a button that silently picks the first frame is worse
 * than no button — there the frames are the way in and the lightbox carries the
 * per-frame way back.
 */
export function gallerySharedPageId(snapshots: BrowserSnapshotRef[]): string | null {
  const pages = new Set(snapshots.map((snapshot) => snapshot.browserPageId))
  return pages.size === 1 ? snapshots[0].browserPageId : null
}
