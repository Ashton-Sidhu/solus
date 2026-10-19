/**
 * When the thread composer is a one-row capsule and when it is the stacked
 * card. The composer stays one row while the user edits, until the draft would
 * not fit on one line of that row (T3 Code #20812).
 *
 * The verdict for "fits on one line" comes from the platform text engine: a
 * hidden copy of the draft is laid out in a frame that has the row's text
 * width (`oneRowMeasureFrame`). Yoga resolves that width from the composer's
 * current width in the same layout pass as the text, so JavaScript never pairs
 * a width from one layout with a width from another. The only inputs from
 * JavaScript are the widths beside the editor, which do not depend on the
 * composer's width. The card never sets them, so the wider card cannot feed
 * back into the verdict.
 */

/**
 * Only this many characters of a draft are laid out to measure it. A longer
 * draft is several lines in any phone or tablet row: even at about 2.5 points
 * a glyph it is wider than any row.
 */
export const ONE_ROW_MEASURE_LIMIT = 1000;

/** Share of the row the draft keeps while editing; a long model label truncates first. */
export const ONE_ROW_MIN_EDITOR_SHARE = "40%";

/** Horizontal padding of the one-row editor (`px-[4px]`). */
const ONE_ROW_EDITOR_PADDING = 4;
/** Room for the caret at the end of a full line. */
const ONE_ROW_CARET_SLACK = 2;

const LINE_BREAK = /[\r\n\u2028\u2029]/;

export interface ComposerLayoutInput {
  /** The editor has focus, or the session settings opened from it are shown. */
  readonly editing: boolean;
  readonly text: string;
  /** Files the user can remove are attached; the card shows them in their strip. */
  readonly hasEditingAttachments: boolean;
  /**
   * The widths beside the editor are known, so the hidden copy can be laid
   * out. Until they are, the row shows: it is where they are measured.
   */
  readonly rowMeasured: boolean;
  /**
   * The last verdict of a layout of the current draft: one line at the row's
   * text width. It is held while a newer layout is on its way.
   */
  readonly fitsOneRow: boolean;
}

/** The draft needs the card: it has its own lines, wraps in the row, or has files to manage. */
export function composerUsesCard(input: ComposerLayoutInput): boolean {
  if (!input.editing) return false;
  if (input.hasEditingAttachments) return true;
  if (input.text.length === 0) return false;
  if (LINE_BREAK.test(input.text) || input.text.length > ONE_ROW_MEASURE_LIMIT) return true;
  return input.rowMeasured && !input.fitsOneRow;
}

/** The part of a draft that is laid out to measure it. */
export function measuredDraftText(text: string): string {
  return text.slice(0, ONE_ROW_MEASURE_LIMIT);
}

/**
 * The verdict of one text layout of the hidden copy, or null when that layout
 * was for another draft. Each line reports its exact substring (Android
 * `FontMetricsUtil`, iOS `RCTTextLayoutManager`), so the lines join to the
 * text they measured. A layout queued for an earlier draft therefore cannot
 * set the verdict of the current one.
 */
export function oneRowVerdict(
  currentMeasuredText: string,
  lines: ReadonlyArray<{ readonly text: string }>,
): boolean | null {
  if (lines.map((line) => line.text).join("") !== currentMeasuredText) return null;
  return lines.length <= 1;
}

/** The widths in the one-row editing layout beside the editor, in points. */
export interface OneRowChrome {
  /** Before the editor: the attach button. */
  readonly leading: number;
  /** After the editor: the model control and the send or stop button. */
  readonly trailing: number;
}

/**
 * The absolute frame, inside the composer's full-width container, whose text
 * area has the width of the one-row editor's text: the space between the
 * chrome, at least the editor's minimum share, less the editor's padding and
 * the caret.
 */
export function oneRowMeasureFrame(chrome: OneRowChrome) {
  return {
    position: "absolute" as const,
    top: 0,
    left: chrome.leading,
    right: chrome.trailing,
    minWidth: ONE_ROW_MIN_EDITOR_SHARE,
    paddingLeft: ONE_ROW_EDITOR_PADDING,
    paddingRight: ONE_ROW_EDITOR_PADDING + ONE_ROW_CARET_SLACK,
  };
}

/**
 * Height of the one-row editor: the pill's 36 points, or one full line when
 * the user's text size needs more.
 */
export function oneRowEditorHeight(lineHeight: number): number {
  return Math.max(36, Math.ceil(lineHeight));
}
