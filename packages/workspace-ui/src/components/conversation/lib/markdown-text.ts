import { decodeHtmlEntities } from "./html-entities";
import { hostPathBaseName } from "@solus/contracts/host-path";

export type MarkdownTextSegment =
  | { type: "text"; value: string }
  | { type: "file"; path: string }
  | { type: "slash"; command: string };

/*
 * `@path` — must start at a boundary, runs until whitespace. `@"a path"` is
 *           the quoted form for a path that holds whitespace.
 * `/cmd`  — must start at a boundary, supports colon-qualified segments,
 *           and must NOT be immediately followed by another path segment or
 *           file extension (avoids matching `/usr/local`, `/test.svelte`, etc.).
 */
const FILE_RE = /(?:^|(?<=\s))@(?:"([^"\n]+)"|([^\s"]\S*))/g;
const SLASH_RE =
  /(?:^|(?<=\s))\/[a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z][a-zA-Z0-9_-]*)*(?![\w./:])/g;

export interface FileChipParts {
  /** The part of the path before the visible label, rendered copy-only. */
  prefix: string;
  /** The basename the chip shows. */
  label: string;
  /** The part of the path after the visible label — a folder's trailing slash. */
  suffix: string;
}

/*
 * A file chip shows only the basename, but a copy of the surrounding prose
 * carries the whole path: a copied file is its path, wherever it is pasted.
 * Splitting the path around the visible label lets the browser's own clipboard
 * serializer reassemble it from copy-only text, with no copy handler and no
 * second selection model. A paste into a composer restores the `@` mention from
 * the chip's `data-solus-reference`.
 */
export function fileChipParts(path: string): FileChipParts {
  const token = path;
  const label = hostPathBaseName(path);
  const start = label ? token.lastIndexOf(label) : token.length;
  return {
    prefix: token.slice(0, start),
    label,
    suffix: token.slice(start + label.length),
  };
}

export interface LinkChipCopyParts {
  /** The link syntax before the visible label, rendered copy-only. */
  open: string;
  /** The link syntax after the visible label, rendered copy-only. */
  close: string;
}

/** The reference a link chip stands for, as a composer writes it — what a paste
 *  of the chip into a composer restores (`data-solus-reference`). */
export function linkReference(label: string, href: string): string {
  return `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${href})`;
}

export interface FileLinkCopyParts extends LinkChipCopyParts {
  /** The shown label is part of the copy. When it is not, the label is drawn
   *  shown-only and `open` carries the whole mention. */
  isLabelCopied: boolean;
}

/*
 * A file in a reply is a Markdown link, and it copies as its path, line kept,
 * as every file chip does. `shown` is the label with the line the chip shows
 * after it (`foo.ts:12`); when the path ends with it, the rest of the path goes
 * before it as copy-only text. A label that is not part of the path (`the
 * config`) cannot be, so the path is copied whole in its place.
 */
export function fileLinkCopyParts(path: string, line: number | undefined, shown: string): FileLinkCopyParts {
  const copied = line ? `${path}:${line}` : path;
  if (!shown || !copied.endsWith(shown)) return { open: copied, close: "", isLabelCopied: false };
  return { open: copied.slice(0, -shown.length), close: "", isLabelCopied: true };
}

export interface FileMentionTarget {
  path: string;
  /** First line of a `path:12` or `path:12-18` mention. */
  line?: number;
}

const LINE_SUFFIX_RE = /^(.+?):(\d+)(?:-\d+)?$/;

/** The file and line a `@path[:line[-end]]` mention opens. */
export function fileMentionTarget(mention: string): FileMentionTarget {
  const match = mention.match(LINE_SUFFIX_RE);
  return match ? { path: match[1], line: Number(match[2]) } : { path: mention };
}

export function tokenizeMarkdownText(text: string): MarkdownTextSegment[] {
  text = decodeHtmlEntities(text);
  type Hit = { start: number; end: number; segment: MarkdownTextSegment };
  const hits: Hit[] = [];

  for (const match of text.matchAll(FILE_RE)) {
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      segment: { type: "file", path: match[1] ?? match[2] },
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
