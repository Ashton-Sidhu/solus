/**
 * The width of a detail panel beside its list — a pull request's review, an
 * Insights turn: the panel opens at the page's own share, the reader drags its
 * edge, and the width is remembered on this device, per page. Both sides keep a
 * floor, so the list stays a readable queue and the panel stays a readable
 * record. A page too narrow for both floors does not split at all; the panel
 * covers the list instead.
 */

export const DETAIL_PANEL_MIN_WIDTH = 360

/** The panel may take at most this share of the page, in percent — whole
 *  numbers, so 70% of 1400 is 980 and not 979.99…. */
const DETAIL_PANEL_MAX_PERCENT = 70

/** Where each page remembers its own width. */
export const DETAIL_PANEL_WIDTH_KEYS = {
  prs: 'solus.prs.panel-width',
  insights: 'solus.insights.panel-width',
} as const

export type DetailPanelPage = keyof typeof DETAIL_PANEL_WIDTH_KEYS

/** Where the panel opens before the reader drags it, in percent of the page.
 *  A review reads beside its queue at half. A turn is a wide record — the
 *  trace, the findings, the rail of cards — and the list beside it is only
 *  navigation, so it opens wider. */
const DETAIL_PANEL_DEFAULT_PERCENT = {
  prs: 50,
  insights: 65,
} as const satisfies Record<DetailPanelPage, number>

/** Whether the page can hold the list and the panel side by side. */
export function canSplitDetailPanel(pageWidth: number): boolean {
  return pageWidth >= DETAIL_PANEL_MIN_WIDTH * 2
}

/** Holds a requested width inside both floors and the share cap. */
export function clampDetailPanelWidth(width: number, pageWidth: number): number {
  const max = Math.max(
    DETAIL_PANEL_MIN_WIDTH,
    Math.min(
      Math.floor((pageWidth * DETAIL_PANEL_MAX_PERCENT) / 100),
      pageWidth - DETAIL_PANEL_MIN_WIDTH,
    ),
  )
  return Math.round(Math.min(max, Math.max(DETAIL_PANEL_MIN_WIDTH, width)))
}

/** The width in effect: the reader's own choice, else the page's default. */
export function detailPanelWidth(
  page: DetailPanelPage,
  savedWidth: number | null,
  pageWidth: number,
): number {
  return clampDetailPanelWidth(
    savedWidth ?? Math.floor((pageWidth * DETAIL_PANEL_DEFAULT_PERCENT[page]) / 100),
    pageWidth,
  )
}

export function readSavedDetailPanelWidth(
  page: DetailPanelPage,
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): number | null {
  const raw = storage?.getItem(DETAIL_PANEL_WIDTH_KEYS[page])
  const width = raw ? Number(raw) : NaN
  return Number.isFinite(width) && width > 0 ? width : null
}

export function saveDetailPanelWidth(
  page: DetailPanelPage,
  width: number,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(DETAIL_PANEL_WIDTH_KEYS[page], String(Math.round(width)))
  } catch {
    // Storage full or blocked: the width holds for this visit only.
  }
}
