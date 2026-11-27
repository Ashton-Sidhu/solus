import {
  parseReferenceTokens,
  referenceCopyText,
  referenceHref,
  type ReferenceParseOptions,
  type ReferenceToken,
  type ReferenceTokenRange,
} from "./reference-tokens";

/**
 * A copied chip is two things. Its plain text is what it reads as — a file's
 * path, an automation's name — because that is what a person pasting it
 * anywhere expects. Its HTML carries the reference itself in this attribute,
 * so a paste back into a composer is the same chip. Every chip that can be
 * copied (in a message, a document, or a composer) carries it.
 */
export const REFERENCE_ATTRIBUTE = "data-solus-reference";

export interface ReferenceClipboard {
  plain: string;
  html: string;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function textHtml(text: string): string {
  return escapeHtml(text).replaceAll("\n", "<br>");
}

/**
 * A composer's text as a copy. `ranges` are the references in `text`, by
 * offset into it; each copies as its readable text and keeps its source.
 */
export function referenceClipboard(text: string, ranges: readonly ReferenceTokenRange[]): ReferenceClipboard {
  let plain = "";
  let html = "";
  let at = 0;
  for (const range of ranges) {
    if (range.from < at) continue;
    const between = text.slice(at, range.from);
    const readable = referenceCopyText(range.token);
    plain += between + readable;
    html += `${textHtml(between)}<span ${REFERENCE_ATTRIBUTE}="${escapeHtml(text.slice(range.from, range.to))}">${escapeHtml(readable)}</span>`;
    at = range.to;
  }
  const rest = text.slice(at);
  return { plain: plain + rest, html: html + textHtml(rest) };
}

/** The text a chip put in a plain copy: not its glyph, and not a label shown in
 *  place of the copied text (`.solus-token__shown-only`). */
function copiedText(chip: Element): string {
  let text = "";
  const walker = chip.ownerDocument.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("svg, .solus-token__shown-only")) text += node.textContent ?? "";
  }
  return text;
}

export function isOneReference(source: string, options: ReferenceParseOptions): boolean {
  const ranges = parseReferenceTokens(source, options);
  return ranges.length === 1 && ranges[0].from === 0 && ranges[0].to === source.length;
}

/**
 * Pasted text with each copied chip put back as its reference, or null when the
 * copy carries none. The plain text is the browser's own serialization, so it
 * keeps the line breaks; each chip's readable text is found in it in order and
 * replaced. A reference this composer does not read stays readable text.
 */
export function restoreReferences(plain: string, html: string, options: ReferenceParseOptions = {}): string | null {
  if (!html.includes(REFERENCE_ATTRIBUTE)) return null;
  const copied = new DOMParser().parseFromString(html, "text/html");
  let restored = "";
  let at = 0;
  for (const chip of copied.querySelectorAll(`[${REFERENCE_ATTRIBUTE}]`)) {
    const source = chip.getAttribute(REFERENCE_ATTRIBUTE) ?? "";
    if (!isOneReference(source, options)) continue;
    const readable = copiedText(chip);
    const index = readable ? plain.indexOf(readable, at) : -1;
    if (index < 0) continue;
    restored += plain.slice(at, index) + source;
    at = index + readable.length;
  }
  return at === 0 ? null : restored + plain.slice(at);
}

/** The one reference `source` is, or null. A slash command is a reference only
 *  where the composer knows it, so it is read here without the command list. */
function referenceIn(source: string): ReferenceToken | null {
  if (/^\/[a-zA-Z-]+(?::[a-zA-Z-]+)*$/.test(source)) return { kind: "slash", command: source };
  const ranges = parseReferenceTokens(source);
  return ranges.length === 1 && ranges[0].from === 0 && ranges[0].to === source.length ? ranges[0].token : null;
}

/** The markup a document editor's own reference node parses for `token`
 *  (`parseHTML` in `fileRefExtension`, `slashRefExtension`, `reference-node`). */
function documentChip(copied: Document, token: ReferenceToken): Node {
  const readable = referenceCopyText(token);
  if (token.kind === "file" || token.kind === "slash") {
    const chip = copied.createElement("span");
    if (token.kind === "file") {
      chip.setAttribute("data-file-ref", token.path);
      chip.setAttribute("path", token.path);
      chip.setAttribute("name", token.name);
    } else {
      chip.setAttribute("data-slash-ref", token.command);
      chip.setAttribute("command", token.command);
    }
    chip.textContent = readable;
    return chip;
  }
  const href = referenceHref(token);
  if (!href) return copied.createTextNode(readable);
  const link = copied.createElement("a");
  link.setAttribute("href", href);
  link.textContent = readable;
  return link;
}

/**
 * Pasted HTML with each copied chip as the markup a document editor parses into
 * the same chip. A chip copied from a message or a composer is a button or a
 * span the editor does not know; its `data-solus-reference` names what it is.
 */
export function referencesAsDocumentHtml(html: string): string {
  // A copy from a document editor holds its own chips, which it parses as they
  // are; rewriting them would drop the slice it pastes by (`data-pm-slice`).
  if (!html.includes(REFERENCE_ATTRIBUTE) || html.includes("data-pm-slice")) return html;
  const copied = new DOMParser().parseFromString(html, "text/html");
  for (const chip of copied.querySelectorAll(`[${REFERENCE_ATTRIBUTE}]`)) {
    const token = referenceIn(chip.getAttribute(REFERENCE_ATTRIBUTE) ?? "");
    if (token) chip.replaceWith(documentChip(copied, token));
  }
  return copied.body.innerHTML;
}
