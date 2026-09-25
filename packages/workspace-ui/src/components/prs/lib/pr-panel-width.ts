/**
 * The width of the pull request panel beside the list: the
 * panel opens at half the page, the reader drags its edge, and the width is
 * remembered on this device. Both sides keep a floor, so the list stays a
 * readable queue and the panel stays a readable review. A page too narrow for
 * both floors does not split at all; the panel covers the list instead.
 */

export const PR_PANEL_MIN_WIDTH = 360

/** The panel may take at most this share of the page, in percent — whole
 *  numbers, so 70% of 1400 is 980 and not 979.99…. */
const PR_PANEL_MAX_PERCENT = 70

/** Where the panel opens before the reader drags it. */
const PR_PANEL_DEFAULT_PERCENT = 50

const STORAGE_KEY = 'solus.prs.panel-width'

/** Whether the page can hold the list and the panel side by side. */
export function canSplitPrPanel(pageWidth: number): boolean {
  return pageWidth >= PR_PANEL_MIN_WIDTH * 2
}

/** Holds a requested width inside both floors and the share cap. */
export function clampPrPanelWidth(width: number, pageWidth: number): number {
  const max = Math.max(
    PR_PANEL_MIN_WIDTH,
    Math.min(Math.floor((pageWidth * PR_PANEL_MAX_PERCENT) / 100), pageWidth - PR_PANEL_MIN_WIDTH),
  )
  return Math.round(Math.min(max, Math.max(PR_PANEL_MIN_WIDTH, width)))
}

/** The width in effect: the reader's own choice, else half of the page. */
export function prPanelWidth(savedWidth: number | null, pageWidth: number): number {
  return clampPrPanelWidth(savedWidth ?? Math.floor((pageWidth * PR_PANEL_DEFAULT_PERCENT) / 100), pageWidth)
}

export function readSavedPrPanelWidth(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): number | null {
  const raw = storage?.getItem(STORAGE_KEY)
  const width = raw ? Number(raw) : NaN
  return Number.isFinite(width) && width > 0 ? width : null
}

export function savePrPanelWidth(width: number, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, String(Math.round(width)))
  } catch {
    // Storage full or blocked: the width holds for this visit only.
  }
}
