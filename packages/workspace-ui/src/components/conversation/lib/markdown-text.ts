import { decodeHtmlEntities } from "./html-entities";

export type MarkdownTextSegment =
  | { type: "text"; value: string }
  | { type: "file"; path: string }
  | { type: "slash"; command: string };

/*
 * `@path` — must start at a boundary, runs until whitespace.
 * `/cmd`  — must start at a boundary, supports colon-qualified segments,
 *           and must NOT be immediately followed by another path segment or
 *           file extension (avoids matching `/usr/local`, `/test.svelte`, etc.).
 */
const FILE_RE = /(?:^|(?<=\s))@[^\s]+/g;
const SLASH_RE =
  /(?:^|(?<=\s))\/[a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z][a-zA-Z0-9_-]*)*(?![\w./:])/g;

export interface FileChipParts {
  /** The part of `@path` before the visible label, rendered copy-only. */
  prefix: string;
  /** The basename the chip shows. */
  label: string;
  /** The part of `@path` after the visible label — a folder's trailing slash. */
  suffix: string;
}

/*
 * A file chip shows only the basename, but a copy of the surrounding prose has
 * to carry the whole `@path` the user wrote: otherwise pasting the selection
 * into another prompt loses the file the sentence was about. Splitting the
 * canonical token around the visible label lets the browser's own clipboard
 * serializer reassemble it from copy-only text, with no copy handler and no
 * second selection model.
 */
export function fileChipParts(path: string): FileChipParts {
  const token = `@${path}`;
  const stripped = path.replace(/\/+$/, "");
  const separator = stripped.lastIndexOf("/");
  const label = separator === -1 ? stripped : stripped.slice(separator + 1);
  const start = label ? token.lastIndexOf(label) : token.length;
  return {
    prefix: token.slice(0, start),
    label,
    suffix: token.slice(start + label.length),
  };
}

export function tokenizeMarkdownText(text: string): MarkdownTextSegment[] {
  text = decodeHtmlEntities(text);
  type Hit = { start: number; end: number; segment: MarkdownTextSegment };
  const hits: Hit[] = [];

  for (const match of text.matchAll(FILE_RE)) {
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      segment: { type: "file", path: match[0].slice(1) },
    });
  }
  for (const match of text.matchAll(SLASH_RE)) {
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      segment: { type: "slash", command: match[0] },
    });
  }
  hits.sort((a, b) => a.start - b.start);

  const segments: MarkdownTextSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, hit.start) });
    }
    segments.push(hit.segment);
    cursor = hit.end;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}
