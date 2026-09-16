// Pure helpers for the conversation message navigator (the user-message rail
// that lives in the workspace reading gutter). Kept out of the .svelte file so
// the component holds only markup + thin handlers.

const REM = 16;

// Mirror of `--solus-reading-max: clamp(30rem, 80%, 68rem)` in
// index.css. The rail only shows when the centered reading column leaves a
// wide-enough gutter, so we reproduce the column width here to know how much
// empty space exists. `tests/unit/panel-sizing.test.ts` reads the token out of
// index.css and fails if these drift from it.
const READING_MIN = 30 * REM; // 480px
const READING_MAX = 68 * REM; // 1088px
const READING_PCT = 0.8;

// The scroll container carries `px-4` (16px each side); the percentage resolves
// against that padded inner box.
const SCROLL_PADDING = 32;

// Minimum clear gutter (px, one side) needed before the rail is worth showing.
// Below this the dashes would crowd the reading text. Because the column grows
// more slowly than the pane, the gutter opens at a conversation pane of ~600px
// and keeps widening from there.
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
