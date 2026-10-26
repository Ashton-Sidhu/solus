// Adapted from T3 Code apps/mobile/src/features/diffs/nativeReviewDiffHighlighter.ts (MIT, see UPSTREAM.md).
// Highlights through `lib/highlights.ts`, which answers in the call with the
// native lexers and with a promise from the Shiki fallback without them.
import {
  highlightCode,
  type HighlightedLines,
  type HighlightScheme,
} from "../../lib/highlights";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import type { NativeReviewDiffRow, NativeReviewDiffToken } from "./nativeReviewDiffSurface";

interface NativeReviewDiffLineRow extends NativeReviewDiffRow {
  readonly kind: "line";
  readonly fileId: string;
  readonly content: string;
}

interface IndexedNativeReviewDiffLineRow {
  readonly row: NativeReviewDiffLineRow;
  readonly rowIndex: number;
}

export interface HighlightNativeReviewDiffVisibleRowsInput {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly scheme: HighlightScheme;
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
  readonly overscanRows?: number;
  readonly maxRows?: number;
  readonly alreadyHighlightedRowIds?: ReadonlySet<string>;
  /** Stops the Shiki fallback; the native lexers finish in the call. */
  readonly signal?: AbortSignal;
}

export interface NativeReviewDiffHighlightedRows {
  readonly tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>>;
  readonly rowCount: number;
}

// Bounds each token patch the native view parses, not the highlighting itself.
const NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS = 160;
const NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS = 360;

function isHighlightableLineRow(row: NativeReviewDiffRow): row is NativeReviewDiffLineRow {
  return row.kind === "line" && row.fileId !== undefined && row.content !== undefined;
}

function hasConsecutiveLineNumbers(
  previous: number | null | undefined,
  next: number | null | undefined,
): boolean {
  return previous != null && next != null && next === previous + 1;
}

function hasOnlyCommentRowsBetween(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  previousRowIndex: number,
  nextRowIndex: number,
): boolean {
  for (let rowIndex = previousRowIndex + 1; rowIndex < nextRowIndex; rowIndex += 1) {
    if (rows[rowIndex]?.kind !== "comment") {
      return false;
    }
  }
  return true;
}

function canShareGrammarContext(
  previous: IndexedNativeReviewDiffLineRow,
  next: IndexedNativeReviewDiffLineRow,
  rows: ReadonlyArray<NativeReviewDiffRow>,
): boolean {
  if (
    next.row.fileId !== previous.row.fileId ||
    !hasOnlyCommentRowsBetween(rows, previous.rowIndex, next.rowIndex)
  ) {
    return false;
  }

  if (previous.row.change === "delete" || next.row.change === "delete") {
    return (
      previous.row.change !== "add" &&
      next.row.change !== "add" &&
      hasConsecutiveLineNumbers(previous.row.oldLineNumber, next.row.oldLineNumber)
    );
  }

  if (previous.row.change === "add" || next.row.change === "add") {
    return hasConsecutiveLineNumbers(previous.row.newLineNumber, next.row.newLineNumber);
  }

  return (
    previous.row.change === "context" &&
    next.row.change === "context" &&
    hasConsecutiveLineNumbers(previous.row.oldLineNumber, next.row.oldLineNumber) &&
    hasConsecutiveLineNumbers(previous.row.newLineNumber, next.row.newLineNumber)
  );
}

function clampRowIndex(index: number, rows: ReadonlyArray<NativeReviewDiffRow>) {
  if (rows.length === 0) {
    return 0;
  }

  return Math.min(rows.length - 1, Math.max(0, Math.floor(index)));
}

function makePlainTokenFallback(
  row: NativeReviewDiffLineRow,
): ReadonlyArray<NativeReviewDiffToken> {
  return [{ content: row.content || " ", color: null, fontStyle: null }];
}

/** Select the line rows near the visible range that are not highlighted yet. */
function selectVisibleHighlightableRows(
  input: HighlightNativeReviewDiffVisibleRowsInput,
  fileMap: ReadonlyMap<string, NativeReviewDiffFile>,
): IndexedNativeReviewDiffLineRow[] {
  const overscanRows = input.overscanRows ?? NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS;
  const maxRows = input.maxRows ?? NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS;
  const startIndex = clampRowIndex(input.firstRowIndex - overscanRows, input.rows);
  const endIndex = clampRowIndex(input.lastRowIndex + overscanRows, input.rows);
  const selectedRows: IndexedNativeReviewDiffLineRow[] = [];

  for (
    let rowIndex = startIndex;
    rowIndex <= endIndex && selectedRows.length < maxRows;
    rowIndex += 1
  ) {
    const row = input.rows[rowIndex];
    if (
      row &&
      isHighlightableLineRow(row) &&
      !input.alreadyHighlightedRowIds?.has(row.id) &&
      fileMap.has(row.fileId)
    ) {
      selectedRows.push({ row, rowIndex });
    }
  }
  return selectedRows;
}

/**
 * Tokens for the line rows near the visible range that are not highlighted
 * yet. Rows that continue each other's source are highlighted together, so
 * multi-line constructs keep their colors. A promise only without the native
 * lexers; after `signal` aborts, it holds no rows.
 */
export function highlightNativeReviewDiffVisibleRows(
  input: HighlightNativeReviewDiffVisibleRowsInput,
): NativeReviewDiffHighlightedRows | Promise<NativeReviewDiffHighlightedRows> {
  const fileMap = new Map(input.files.map((file) => [file.id, file]));
  const selectedRows = selectVisibleHighlightableRows(input, fileMap);

  const segments: IndexedNativeReviewDiffLineRow[][] = [];
  for (const selectedRow of selectedRows) {
    const segment = segments.at(-1);
    const previousRow = segment?.at(-1);
    if (segment && previousRow && canShareGrammarContext(previousRow, selectedRow, input.rows)) {
      segment.push(selectedRow);
    } else {
      segments.push([selectedRow]);
    }
  }

  const highlighted = segments.map((segment) =>
    highlightCode(
      segment.map(({ row }) => row.content).join("\n"),
      fileMap.get(segment[0].row.fileId)?.language ?? "text",
      input.scheme,
      input.signal,
    ),
  );
  const collect = (
    tokenLines: ReadonlyArray<HighlightedLines>,
  ): NativeReviewDiffHighlightedRows => {
    if (input.signal?.aborted) return { tokensByRowId: {}, rowCount: 0 };
    const tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
    segments.forEach((segment, segmentIndex) => {
      segment.forEach(({ row }, rowIndex) => {
        tokensByRowId[row.id] = tokenLines[segmentIndex][rowIndex] ?? makePlainTokenFallback(row);
      });
    });
    return { tokensByRowId, rowCount: selectedRows.length };
  };

  const settled: HighlightedLines[] = [];
  for (const lines of highlighted) {
    if (lines instanceof Promise) return Promise.all(highlighted).then(collect);
    settled.push(lines);
  }
  return collect(settled);
}
