import type { Attachment, BrowserMark } from "@solus/contracts/types";

/**
 * One chip in the row: a single mark, and everything a reader needs about it.
 *
 * There is no second chip. The pin is the identity — the same number the
 * overlay drew on the page, the prompt lists, and the agent names back — so it
 * is carried, never derived from where the chip happens to sit in the row. The
 * page and viewport ride every chip rather than one shared chip, because a chip
 * read on its own, months later, has to be able to say where it came from.
 */
export interface BrowserMarkChip {
  id: string;
  tool: BrowserMark["tool"];
  pin: number;
  /** What the mark landed on, ready to print. */
  label: string;
  /** The label is the user's own words rather than a selector, so it is set in
   *  the body face inside quotes instead of mono. */
  isQuote: boolean;
  /** Spelled-out hover detail: "Comment on a.cta-download". */
  title: string;
  /** The mark still resolves to something on the page. A mark whose element is
   *  gone keeps its chip — the rect is what still makes it meaningful. */
  resolved: boolean;
  /** host:port of the page. Never truncated: it is what tells two worktrees
   *  serving the same app apart. */
  host: string | null;
  /** The path, which is the part that gives when the row is tight. */
  path: string;
  /** The colour scheme the page was marked up under, and only when it was not
   *  the app's own — the one fact about the capture a reader cannot infer. */
  theme: "light" | "dark" | null;
}

/** How the tool reads in a tooltip. The glyph is the compact form of the same
 *  fact, and the two must not disagree. */
const TOOL_NOUN = {
  pick: "Comment on",
  region: "Region around",
  draw: "Drawing on",
} satisfies Record<BrowserMark["tool"], string>;

/** The selector's cap. Longer than this is unreadable at chip size, and the
 *  ends are the identifying halves — so the middle goes, not the tail. */
const LABEL_MAX_CHARS = 28;

export function middleEllipsis(text: string, max = LABEL_MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** The first four words of a note, which is what a mark with no element has to
 *  identify itself with. */
function quotedNote(note: string): string {
  const words = note.trim().split(/\s+/).slice(0, 4).join(" ");
  return `“${words}${note.trim().split(/\s+/).length > 4 ? "…" : ""}”`;
}

/** Every mark in the attachment, in pin order. Empty for an attachment written
 *  before marks were carried. */
export function browserMarkChips(attachment: Attachment): BrowserMarkChip[] {
  const data = attachment.designData;
  const address = splitAddress(data?.pageURL);

  return (data?.browserMarks ?? []).map((mark) => {
    const selector = mark.selector?.trim();
    const note = mark.note?.trim();
    const isQuote = !selector && !!note;
    const raw = selector || (note ? quotedNote(note) : `mark ${mark.pin}`);
    return {
      id: mark.id,
      tool: mark.tool,
      pin: mark.pin,
      label: isQuote ? raw : middleEllipsis(raw),
      isQuote,
      title: `${TOOL_NOUN[mark.tool]} ${raw}`,
      resolved: !!selector || isQuote,
      host: address.host,
      path: address.path,
      theme: data?.browserAppearance ?? null,
    };
  });
}

/**
 * The address split where the chip is allowed to give.
 *
 * Scheme, query and hash are noise at chip size. The host is what tells two
 * worktrees serving the same app apart, so it is never the part that gets cut —
 * the path is.
 */
interface ChipAddress {
  host: string | null;
  path: string;
}

function splitAddress(pageURL: string | undefined): ChipAddress {
  if (!pageURL) return { host: null, path: "" };
  try {
    const url = new URL(pageURL);
    return { host: url.host || null, path: url.pathname === "/" ? "" : url.pathname };
  } catch {
    return { host: null, path: "" };
  }
}
