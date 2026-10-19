// Pure helpers for the conversation message navigator (the user-message rail
// that lives in the workspace reading gutter). Kept out of the .svelte file so
// the component holds only markup + thin handlers.

import type { ConversationWidth } from "@solus/contracts/settings";

const REM = 16;

// Mirror of `--solus-reading-max` in workspace.css, one rule per
// "Conversation width". The rail only shows when the centered reading column
// leaves a wide-enough gutter, so we reproduce the column width here to know
// how much empty space exists. `tests/unit/panel-sizing.test.ts` pins the
// widths, so a change to one side fails until the other follows.
const READING_MAX = 68 * REM; // 1088px
const READING_PCT = 0.65;
// A narrow pane fills its width less this gutter until the column reaches the floor.
const NARROW_GUTTER = 4 * REM;
const READING_FLOOR = 46 * REM;
const NARROW_MEASURE = 40 * REM;

// The scroll container carries `px-4` (16px each side); the percentage resolves
// against that padded inner box.
const SCROLL_PADDING = 32;

// Minimum clear gutter (px, one side) needed before the rail is worth showing.
// Below this the dashes would crowd the reading text. At the comfortable width
// the column fills a narrow pane, so the gutter opens only once the column
// stops at its 46rem floor.
export const MIN_GUTTER = 60;

// Distance (px) from the scroll container's top that marks the "current"
// message: the last user message whose top has crossed this line is active.
const ACTIVE_LINE = 96;

export interface NavItem {
  id: string;
  /** Single-line hover preview, precomputed at build time so the rail rows never
   *  re-derive it (see previewText). */
  preview: string;
}

/** Rebuild only when message membership changes, never on a scroll frame. */
export function indexMinimapNodes(container: HTMLElement, items: NavItem[]) {
  const nodes = new Map<string, HTMLElement>();
  for (const node of container.querySelectorAll<HTMLElement>("[data-nav-msg-id]")) {
    const id = node.dataset.navMsgId;
    if (id) nodes.set(id, node);
  }
  return { nodes, firstMountedIndex: items.findIndex((item) => nodes.has(item.id)) };
}

/** Width (px) of the centered reading column inside the scroll box's padding. */
function readingWidth(inner: number, width: ConversationWidth): number {
  if (width === "full") return inner;
  const filled = Math.max(0, inner - NARROW_GUTTER);
  if (width === "narrow") return Math.min(filled, NARROW_MEASURE);
  return Math.min(READING_MAX, Math.max(inner * READING_PCT, Math.min(filled, READING_FLOOR)));
}

/** Width (px) of one side gutter between the centered reading column and the pane edge. */
export function gutterWidth(paneWidth: number, width: ConversationWidth): number {
  if (paneWidth <= 0) return 0;
  const inner = Math.max(0, paneWidth - SCROLL_PADDING);
  return Math.max(0, (paneWidth - readingWidth(inner, width)) / 2);
}

/** Whether the gutter is wide enough to host the rail without crowding text. */
export function hasRoomForRail(paneWidth: number, width: ConversationWidth): boolean {
  return gutterWidth(paneWidth, width) >= MIN_GUTTER;
}

/**
 * Pick the active index from message top offsets (px, relative to the scroll
 * container's top), read lazily and in document order via `topAt(i)`. The active
 * message is the last one whose top has scrolled above the active line; once a
 * message sits below the line every later one does too, so we stop early — the
 * caller's `topAt` (a getBoundingClientRect read) is never invoked past the fold.
 */
export function pickActiveIndex(
  count: number,
  topAt: (i: number) => number | null,
  firstMountedIndex = 0,
): number {
  let active = Math.max(0, firstMountedIndex - 1);
  for (let i = Math.max(0, firstMountedIndex); i < count; i++) {
    const mountedTop = topAt(i);
    // Windowed transcript rows before the first mounted item are above the
    // viewport. Missing rows after it have not been reached yet.
    const top =
      mountedTop ??
      (i < firstMountedIndex
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY);
    if (top - ACTIVE_LINE <= 0) active = i;
    else break;
  }
  return active;
}

/** Collapse whitespace into a single-line preview for the hover label. */
export function previewText(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean || "Attachment";
}

/** The shape the rail needs off a transcript row; anything wider is the caller's. */
interface NavSourceMessage {
  id: string;
  role: string;
  content: string;
}

/**
 * Build the rail's items, reusing both the per-message preview and the array
 * itself whenever the user messages have not changed.
 *
 * Two costs hang off this. The preview is a whitespace regex over the whole
 * message, and rebuilding it for every user message is wasted work — a sent
 * message's text does not move. The array identity is the expensive one: the
 * component re-indexes the transcript (`querySelectorAll` over every mounted
 * row) whenever `items` changes, so handing back a fresh-but-equal array on
 * each new tool row makes a long turn re-walk the DOM once per row.
 *
 * Returning the previous array unchanged stops that: an unchanged `$derived`
 * value does not propagate, so the index survives the turn.
 */
export function createNavItemBuilder(): (messages: readonly NavSourceMessage[]) => NavItem[] {
  // Keyed by the message object, so a row that is dropped from the transcript
  // takes its cache entry with it. Content is stored alongside because an
  // edited message keeps its identity but must not keep its preview.
  const cache = new WeakMap<object, { content: string; item: NavItem }>();
  let previous: NavItem[] = [];

  return function build(messages: readonly NavSourceMessage[]): NavItem[] {
    const next: NavItem[] = [];
    let matchesPrevious = true;
    for (const message of messages) {
      if (message.role !== "user") continue;
      const cached = cache.get(message);
      let item: NavItem;
      if (cached && cached.content === message.content) {
        item = cached.item;
      } else {
        item = { id: message.id, preview: previewText(message.content) };
        cache.set(message, { content: message.content, item });
      }
      // Cached items are identity-stable, so `!==` catches an added, removed,
      // reordered or re-previewed row without comparing any strings.
      if (matchesPrevious && previous[next.length] !== item) matchesPrevious = false;
      next.push(item);
    }
    if (matchesPrevious && next.length === previous.length) return previous;
    previous = next;
    return next;
  };
}
