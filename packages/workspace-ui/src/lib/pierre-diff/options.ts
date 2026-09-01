import type { FileDiffContentsLoader } from '@pierre/diffs'
import { DIFFS_THEME_CSS } from '../diffTheme'
import { getDiffThemeName } from '../diff-worker-pool'

// Lines revealed per expansion click (library default 100 — too big a jump to
// keep your place) and the gap size below which the renderer just draws the
// unchanged lines inline instead of asking for a click (default 1). They only
// mean anything once a loader can supply the surrounding contents.
const EXPANSION_LINE_COUNT = 20
const COLLAPSED_CONTEXT_THRESHOLD = 10

export interface DiffRenderOptionsInput {
  isDark: boolean
  /** Side-by-side is a per-surface reader preference; cards are always unified. */
  diffStyle?: 'unified' | 'split'
  /** Word-level highlighting inside a changed line; 'none' keeps line-level backgrounds. */
  lineDiffType?: 'word-alt' | 'none'
  /**
   * 'metadata' draws the raw `@@` rule. 'line-info-basic' says how many lines it
   * skipped and, with a loader attached, lets the reader pull them in.
   */
  hunkSeparators?: 'metadata' | 'line-info-basic'
  /** Absent means the surface cannot expand context, and hydration never runs. */
  loadDiffFiles?: FileDiffContentsLoader
  disableFileHeader?: boolean
  /** Appended after the shared theme CSS, so a surface can add its own rules. */
  extraCSS?: string
  onPostRender?: (node: HTMLElement) => void
}

/**
 * The options every Solus diff surface agrees on. A surface spreads this and
 * adds what is genuinely its own — annotations, selection, sticky headers,
 * layout metrics — rather than restating the theme, indicator, and expansion
 * choices that should never differ between the conversation, the diff stream,
 * and a review card.
 */
export function diffRenderOptions({
  isDark,
  diffStyle = 'unified',
  lineDiffType = 'word-alt',
  hunkSeparators = 'line-info-basic',
  loadDiffFiles,
  disableFileHeader = true,
  extraCSS,
  onPostRender,
}: DiffRenderOptionsInput) {
  return {
    theme: getDiffThemeName(isDark),
    themeType: isDark ? ('dark' as const) : ('light' as const),
    diffStyle,
    diffIndicators: 'none' as const,
    lineDiffType,
    overflow: 'wrap' as const,
    hunkSeparators,
    disableFileHeader,
    unsafeCSS: extraCSS ? `${DIFFS_THEME_CSS}\n${extraCSS}` : DIFFS_THEME_CSS,
    // Without a loader a render failure has nowhere to go but the caller's
    // try/catch; with one, hydration failures are non-fatal and @pierre keeps
    // showing the partial patch.
    disableErrorHandling: loadDiffFiles == null,
    loadDiffFiles,
    // @pierre/diffs destructures these with defaults, so leaving them undefined
    // where the surface cannot expand context is the same as omitting them.
    expansionLineCount: loadDiffFiles ? EXPANSION_LINE_COUNT : undefined,
    collapsedContextThreshold: loadDiffFiles ? COLLAPSED_CONTEXT_THRESHOLD : undefined,
    onPostRender,
  }
}
