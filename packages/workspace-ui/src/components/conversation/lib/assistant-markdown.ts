import type { SvelteMarkdownOptions } from "@humanspeak/svelte-markdown";
import type { MarkedExtension } from "marked";
import { bareTagMarkedExtension, rawHtmlMarkedExtension } from "./raw-html";
import {
  FILE_CHIP_PUNCTUATION_RE,
  SPACED_IMAGE_PATH_RE,
  alertMarkedExtension,
  fileChipGroupMarkedExtension,
  footnoteMarkedExtension,
  spacedImagePathMarkedExtension,
} from "./markdown-extensions";
import { decodeHtmlEntities } from "./html-entities";

export const assistantMarkdownOptions: SvelteMarkdownOptions = {};

/**
 * A code span inside a file link would otherwise render CodeSpan's clickable
 * file chip inside MarkdownLink's clickable file chip. Return its plain label
 * so the outer link remains the only interactive shell.
 */
export function codeFileLinkLabel(text: string | undefined, line?: number): string | null {
  const match = text?.match(/^(`+)([\s\S]*)\1$/);
  if (!match) return null;

  const label = decodeHtmlEntities(match[2]);
  const lineSuffix = line ? `:${line}` : "";
  return lineSuffix && label.endsWith(lineSuffix)
    ? label.slice(0, -lineSuffix.length)
    : label;
}

const ALERT_RE = /^ {0,3}>\s*\[!(?:note|tip|important|warning|caution)\]/im;
const FOOTNOTE_RE = /\[\^[^\]\s]+\]/;

/** One array per combination, so the parser config keeps its identity while a
 *  reply streams and the incremental parser is not rebuilt on every token. */
const extensionSets = new Map<number, MarkedExtension[]>();

function extensionSet(
  rawHtml: boolean,
  alert: boolean,
  footnote: boolean,
  spacedImagePath: boolean,
  fileChipPunctuation: boolean,
): MarkedExtension[] {
  const key = (rawHtml ? 1 : 0) | (alert ? 2 : 0) | (footnote ? 4 : 0) | (spacedImagePath ? 8 : 0) | (fileChipPunctuation ? 16 : 0);
  let set = extensionSets.get(key);
  if (!set) {
    set = [
      ...(rawHtml ? [rawHtmlMarkedExtension, bareTagMarkedExtension] : []),
      ...(alert ? [alertMarkedExtension] : []),
      ...(footnote ? [footnoteMarkedExtension] : []),
      ...(spacedImagePath ? [spacedImagePathMarkedExtension] : []),
      ...(fileChipPunctuation ? [fileChipGroupMarkedExtension] : []),
    ];
    extensionSets.set(key, set);
  }
  return set;
}

/** The scan of a reply as of its last complete line. */
type ExtensionScan = {
  source: string;
  /** Index after the last newline scanned. */
  lineStart: number;
  /** The open code fence at `lineStart`, if any. */
  fence: string | undefined;
  rawHtml: boolean;
  alert: boolean;
  footnote: boolean;
  spacedImagePath: boolean;
  fileChipPunctuation: boolean;
};

/** Reads one line outside or inside a code fence: the fence it leaves open,
 *  and whether it holds raw HTML. */
function scanLine(line: string, fence: string | undefined): { fence: string | undefined; rawHtml: boolean } {
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  if (marker) {
    if (!fence) return { fence: marker, rawHtml: false };
    if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) return { fence: undefined, rawHtml: false };
    return { fence, rawHtml: false };
  }
  return { fence, rawHtml: !fence && line.includes("<") };
}

/** The last reply scanned. A streaming reply only grows, so the next token
 *  scans only the new text, not the whole reply again. */
let lastScan: ExtensionScan | undefined;

function scanExtensions(source: string): ExtensionScan {
  const previous = lastScan && source.startsWith(lastScan.source) ? lastScan : undefined;
  const scan: ExtensionScan = previous
    ? { ...previous, source }
    : { source, lineStart: 0, fence: undefined, rawHtml: false, alert: false, footnote: false, spacedImagePath: false, fileChipPunctuation: false };
  // A pattern can begin on the last line of old text, and an alert's `>` can
  // sit before blank lines: test from the line of the last non-blank text.
  let last = scan.lineStart - 1;
  while (last >= 0 && /\s/.test(source[last])) last--;
  const tail = source.slice(source.lastIndexOf("\n", last) + 1);
  scan.alert ||= ALERT_RE.test(tail);
  scan.footnote ||= FOOTNOTE_RE.test(tail);
  scan.spacedImagePath ||= SPACED_IMAGE_PATH_RE.test(tail);
  scan.fileChipPunctuation ||= FILE_CHIP_PUNCTUATION_RE.test(tail);
  let lineStart = scan.lineStart;
  while (!scan.rawHtml) {
    const lineEnd = source.indexOf("\n", lineStart);
    const line = scanLine(source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd), scan.fence);
    scan.rawHtml = line.rawHtml;
    // The last line is not complete: a closing fence can still grow into text.
    if (lineEnd === -1) break;
    scan.fence = line.fence;
    lineStart = lineEnd + 1;
  }
  // Raw HTML is final: the fence state no longer matters.
  scan.lineStart = scan.rawHtml ? source.lastIndexOf("\n") + 1 : lineStart;
  lastScan = scan;
  return scan;
}

/** Raw HTML can merge adjacent blocks and requires the full parser, and so do
 * footnotes, whose references and definitions cross blocks. GitHub alerts,
 * image paths with spaces, and a file chip with its punctuation stay inside their own span and keep the incremental
 * parser. Each extension is added only
 * when the reply uses its syntax, so ordinary prose and fenced source keep the
 * library's stable-prefix incremental parser. */
export function assistantMarkdownExtensions(source: string): MarkedExtension[] {
  const scan = scanExtensions(source);
  return extensionSet(scan.rawHtml, scan.alert, scan.footnote, scan.spacedImagePath, scan.fileChipPunctuation);
}
