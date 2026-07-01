// Pure helpers for the conversation message navigator (the user-message rail
// that lives in the editor-mode reading gutter). Kept out of the .svelte file so
// the component holds only markup + thin handlers.

const REM = 16;

// Mirror of `--solus-reading-max: clamp(40rem, 92%, 80rem)` in index.css. The
// rail only shows when the centered reading column leaves a wide-enough gutter,
// so we reproduce the column width here to know how much empty space exists.
const READING_MIN = 40 * REM; // 640px
const READING_MAX = 80 * REM; // 1280px
const READING_PCT = 0.92;

// The scroll container carries `px-4` (16px each side); the 92% clamp resolves
// against that padded inner box.
const SCROLL_PADDING = 32;

// Minimum clear gutter (px, one side) needed before the rail is worth showing.
// Below this the dashes would crowd the reading text. With reading-min 640px
// this corresponds to a conversation pane of ~1130px and up.
export const MIN_GUTTER = 60;

// Distance (px) from the scroll container's top that marks the "current"
// message: the last user message whose top has crossed this line is active.
const ACTIVE_LINE = 96;

// Approximate on-screen width of the collapsed rail, used to centre it in the
// gutter.
export const RAIL_WIDTH = 30;

export interface NavItem {
  id: string;
  text: string;
}

/** Width (px) of one side gutter between the centered reading column and the pane edge. */
export function gutterWidth(paneWidth: number): number {
  if (paneWidth <= 0) return 0;
  const inner = Math.max(0, paneWidth - SCROLL_PADDING);
  const reading = Math.min(
    inner,
    Math.min(READING_MAX, Math.max(READING_MIN, inner * READING_PCT)),
  );
  return Math.max(0, (paneWidth - reading) / 2);
}

/** Whether the gutter is wide enough to host the rail without crowding text. */
export function hasRoomForRail(paneWidth: number): boolean {
  return gutterWidth(paneWidth) >= MIN_GUTTER;
}

/** Right offset (px) that centres the collapsed rail within the gutter. */
export function railRightOffset(paneWidth: number): number {
  return Math.max(10, Math.round((gutterWidth(paneWidth) - RAIL_WIDTH) / 2));
}

/**
 * Pick the active index from each message's top offset (px, relative to the
 * scroll container's top), in document order. The active message is the last one
 * whose top has scrolled above the active line; once a message sits below the
 * line every later one does too, so we can stop early.
 */
export function pickActiveIndex(tops: number[]): number {
  let active = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] - ACTIVE_LINE <= 0) active = i;
    else break;
  }
  return active;
}

/** Collapse whitespace into a single-line preview for the hover label. */
export function previewText(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean || "Attachment";
}
