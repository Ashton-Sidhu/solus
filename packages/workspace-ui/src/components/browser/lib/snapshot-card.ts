import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'

/** Which glyph stands for a capture. Read from the width the capture was taken
 *  at, so a card says at a glance whether it is looking at a phone or a desktop
 *  before the reader parses a single word of the caption. */
export type SnapshotDeviceKind = 'phone' | 'tablet' | 'desktop'

/**
 * What a capture is, taken apart for display.
 *
 * The contract formats one viewport label — `iPhone 15 — 393×852` — so the
 * pane, the agent's transcript, and this card cannot describe one capture three
 * different ways. The card shows the two halves in different places: the device
 * belongs in the caption beside the page, the size belongs on the picture it
 * describes. Splitting it here keeps that the card's arrangement rather than a
 * second format nobody else knows about.
 */
export interface SnapshotFacts {
  /** The device the capture was taken as, e.g. `iPhone 15`. */
  device: string
  /** The pixel size, e.g. `393×852`. Empty when the label carries no size. */
  size: string
  deviceKind: SnapshotDeviceKind
  /**
   * The shape the card takes, width and height together.
   *
   * The card is sized *by* this rather than merely reserving it: a fixed-width
   * card holding a capture of another shape is all empty ground, which is the
   * one thing a card whose whole job is showing a picture cannot afford. The
   * image is also fetched from the asset store after the card is on screen, so
   * holding the shape from the first frame is what stops a capture landing
   * mid-turn from shoving the transcript under the reader.
   */
  aspectRatio: string
}

/** The shapes a card will take. Past either end what is extreme is the page —
 *  a full-page capture scrolled for a minute, or a panorama — not the device,
 *  and a card shaped like that is a card nobody can read the caption of. */
const NARROWEST_CARD = 0.5
const WIDEST_CARD = 3

const VIEWPORT_SEPARATOR = ' — '

function deviceKindFor(width: number): SnapshotDeviceKind {
  if (width < 600) return 'phone'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

export function snapshotFacts(snapshot: BrowserSnapshotRef): SnapshotFacts {
  const cut = snapshot.viewport.lastIndexOf(VIEWPORT_SEPARATOR)
  // A label with no size is still a label: a custom viewport names its numbers
  // and nothing else, and the card has to render it rather than a blank chip.
  if (cut < 0) {
    return {
      device: snapshot.viewport,
      size: '',
      deviceKind: 'desktop',
      aspectRatio: '1.6',
    }
  }
  const device = snapshot.viewport.slice(0, cut)
  const size = snapshot.viewport.slice(cut + VIEWPORT_SEPARATOR.length)
  const [width, height] = size.split('×').map((part) => Number.parseInt(part, 10))
  if (!width || !height) {
    return { device, size, deviceKind: 'desktop', aspectRatio: '1.6' }
  }
  return {
    device,
    size,
    deviceKind: deviceKindFor(width),
    aspectRatio: `${Math.min(Math.max(width / height, NARROWEST_CARD), WIDEST_CARD)}`,
  }
}

/**
 * The line beside the card's title.
 *
 * The image says what the page looked like; this says what it *was* — the device
 * it was taken as, and how much of it the agent could actually reach. Neither is
 * legible from the pixels. Where it came from is stated once, in the footer's
 * address, rather than twice on one card.
 */
export function snapshotCaption(snapshot: BrowserSnapshotRef): string {
  const facts = snapshotFacts(snapshot)
  const elements = `${snapshot.elementCount} element${snapshot.elementCount === 1 ? '' : 's'}`
  return [facts.device, elements].filter(Boolean).join(' · ')
}

/**
 * The address, as the card's footer states it.
 *
 * Two worktrees serving the same app produce identical screenshots and differ
 * only by port, so the host is the one thing that says which of them this is.
 * The scheme is never the interesting part and a bare host loses which route was
 * captured, so the two are shown together with the scheme dropped — the same
 * reading order the pane's own address field uses.
 */
export function snapshotAddress(snapshot: BrowserSnapshotRef): string {
  try {
    const url = new URL(snapshot.url)
    return `${url.host}${url.pathname}${url.search}`
  } catch {
    return snapshot.url
  }
}

/**
 * The stamp burned into the corner of the frame.
 *
 * A frame is evidence, and evidence with no provenance is decoration: the size
 * and the colour scheme are the two facts a reader cannot recover from the
 * pixels a day later. `system` is deliberately not stated — it is a mode, not a
 * rendering, and the picture already shows which way it resolved.
 */
export function snapshotStamp(snapshot: BrowserSnapshotRef): string {
  const size = snapshotFacts(snapshot).size || snapshot.viewport
  if (snapshot.appearance === 'system') return size
  return `${size} · ${snapshot.appearance}`
}

/**
 * The console count worth interrupting for.
 *
 * A page can look correct and be broken, so an error count belongs next to the
 * picture rather than buried in the agent's tool output — but a zero is noise,
 * and a card that always carries a badge teaches people to stop reading it.
 */
export function snapshotErrorLabel(snapshot: BrowserSnapshotRef): string | null {
  if (snapshot.consoleErrors <= 0) return null
  return `${snapshot.consoleErrors} console error${snapshot.consoleErrors === 1 ? '' : 's'}`
}

/**
 * The width the page was laid out at, in its own CSS pixels.
 *
 * Not the PNG's width: a capture is taken at the display's pixel ratio, so the
 * file is commonly twice the page. Showing a frame "at 100%" means at the size
 * the browser drew it, which is this — anything else is a magnifying glass that
 * calls itself actual size. 0 when the viewport label carries no numbers.
 */
export function snapshotWidth(snapshot: BrowserSnapshotRef): number {
  const width = Number.parseInt(snapshotFacts(snapshot).size.split('×')[0] ?? '', 10)
  return Number.isFinite(width) ? width : 0
}

/** The page's own name for itself, falling back to its address. A capture with
 *  neither is still a capture, so it never renders an empty line. */
export function snapshotTitle(snapshot: BrowserSnapshotRef): string {
  return snapshot.title || snapshot.url || 'Browser'
}
