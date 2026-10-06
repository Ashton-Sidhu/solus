// Solus column sizing for native markdown tables. T3 gave every cell a fixed
// 160pt width, so a table never used a wide pane and a code identifier longer
// than 160pt broke across lines. This sizes each column from its text, as the
// desktop transcript table does (`.prose-transcript` in workspace.css). T3's box,
// header fill and padding stay (NativeMarkdownBlock.tsx).
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";

/** Horizontal padding on each side of a cell, as T3's table. */
export const MARKDOWN_TABLE_CELL_PADDING_X = 10;
const MIN_COLUMN_WIDTH = 56;
/** A column grows to fit its longest unbroken word up to this width; past it the word wraps. */
const MAX_WORD_WIDTH = 260;
/** A long cell wraps at this width, so one column cannot push the others out (desktop: 24rem). */
const MAX_PREFERRED_COLUMN_WIDTH = 384;
// Average glyph advance in ems. These are estimates on the generous side, so a
// word sized from them fits its column without a break.
const PROSE_EM = 0.56;
const CODE_EM = 0.62;

export interface MarkdownTableCellMetrics {
  /** Estimated width of the longest run of text without a space. */
  readonly longestWord: number;
  /** Estimated width of the whole cell on one line. */
  readonly singleLine: number;
}

/** Estimates a cell's text widths from its runs. Words can span runs, as in `foo`**bar**. */
export function measureMarkdownTableCell(
  runs: ReadonlyArray<NativeMarkdownTextRun>,
  fontSize: number,
): MarkdownTableCellMetrics {
  let longestWord = 0;
  let word = 0;
  let singleLine = 0;
  for (const run of runs) {
    const advance = fontSize * (run.code ? CODE_EM : PROSE_EM);
    const text = run.skillLabel ?? run.text;
    for (const char of text) {
      singleLine += advance;
      if (/\s/.test(char)) {
        word = 0;
      } else {
        word += advance;
        longestWord = Math.max(longestWord, word);
      }
    }
  }
  return { longestWord, singleLine };
}

/**
 * Column widths for a table in a pane `availableWidth` wide (0 before layout).
 *
 * - Every column fits its longest word, so an identifier does not break.
 * - When every column fits its text on one line, the table fills the pane and
 *   the extra width goes to each column in proportion to its text.
 * - Otherwise the columns between their word width and their text width share
 *   the pane, and their cells wrap at spaces.
 * - When the longest words alone are wider than the pane, the table keeps
 *   those widths and scrolls sideways.
 */
export function deriveMarkdownTableColumnWidths(
  rows: ReadonlyArray<ReadonlyArray<MarkdownTableCellMetrics>>,
  availableWidth: number,
): number[] {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const padding = MARKDOWN_TABLE_CELL_PADDING_X * 2;
  const minimum: number[] = [];
  const preferred: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    let longestWord = 0;
    let singleLine = 0;
    for (const row of rows) {
      const cell = row[column];
      if (!cell) continue;
      longestWord = Math.max(longestWord, cell.longestWord);
      singleLine = Math.max(singleLine, cell.singleLine);
    }
    const min = Math.max(MIN_COLUMN_WIDTH, Math.min(longestWord, MAX_WORD_WIDTH) + padding);
    minimum.push(min);
    preferred.push(Math.max(min, Math.min(singleLine + padding, MAX_PREFERRED_COLUMN_WIDTH)));
  }

  const sum = (widths: number[]) => widths.reduce((total, width) => total + width, 0);
  const minimumTotal = sum(minimum);
  const preferredTotal = sum(preferred);
  let widths: number[];
  if (availableWidth <= 0) {
    widths = preferred;
  } else if (minimumTotal >= availableWidth) {
    widths = minimum;
  } else if (preferredTotal <= availableWidth) {
    const extra = availableWidth - preferredTotal;
    widths = preferred.map((width) => width + (extra * width) / preferredTotal);
  } else {
    const share = (availableWidth - minimumTotal) / (preferredTotal - minimumTotal);
    widths = minimum.map((width, column) => width + (preferred[column]! - width) * share);
  }
  // Round down so the sum never passes the pane by a fraction and starts a scroll.
  return widths.map(Math.floor);
}
