import { SYSTEM_FONT } from './system-font'

/** T3 Code's type scale for native style props (`src/lib/typography.ts`, MIT,
 *  see UPSTREAM.md). Keep it aligned with the `--text-*` scale in global.css. */
export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: 11, lineHeight: 14 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 17 },
  footnote: { fontSize: 14, lineHeight: 19 },
  body: { fontSize: 16, lineHeight: 23 },
  headline: { fontSize: 18, lineHeight: 23 },
  title: { fontSize: 21, lineHeight: 28 },
  largeTitle: { fontSize: 26, lineHeight: 32 },
  display: { fontSize: 30, lineHeight: 36 },
} as const

/** Shared geometry for dense, horizontally scrolling code surfaces. */
export const MOBILE_CODE_SURFACE = {
  rowHeight: 22,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
  lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
} as const

/** The system font, as Solus's `--solus-font-family`. One family on each
 *  platform: a caller sets the weight with `fontWeight`. Keep aligned with the
 *  `--font-*` variables in global.css. */
export const MOBILE_FONTS = {
  regular: SYSTEM_FONT,
  medium: SYSTEM_FONT,
  semibold: SYSTEM_FONT,
  bold: SYSTEM_FONT,
} as const
