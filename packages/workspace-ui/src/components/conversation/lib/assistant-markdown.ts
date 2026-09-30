import type { SvelteMarkdownOptions } from "@humanspeak/svelte-markdown";
import type { MarkedExtension } from "marked";
import { rawHtmlMarkedExtension } from "./raw-html";
import { alertMarkedExtension, footnoteMarkedExtension } from "./markdown-extensions";
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

function extensionSet(rawHtml: boolean, alert: boolean, footnote: boolean): MarkedExtension[] {
  const key = (rawHtml ? 1 : 0) | (alert ? 2 : 0) | (footnote ? 4 : 0);
  let set = extensionSets.get(key);
  if (!set) {
    set = [
      ...(rawHtml ? [rawHtmlMarkedExtension] : []),
      ...(alert ? [alertMarkedExtension] : []),
      ...(footnote ? [footnoteMarkedExtension] : []),
    ];
    extensionSets.set(key, set);
  }
  return set;
}

function hasRawHtml(source: string): boolean {
  let fence: string | undefined;
  for (const line of source.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (!fence && line.includes("<")) {
      return true;
    }
  }
  return false;
}

/** Raw HTML can merge adjacent blocks and requires the full parser, and so do
 * footnotes, whose references and definitions cross blocks. GitHub alerts are
 * block-anchored and keep the incremental parser. Each extension is added only
 * when the reply uses its syntax, so ordinary prose and fenced source keep the
 * library's stable-prefix incremental parser. */
export function assistantMarkdownExtensions(source: string): MarkedExtension[] {
  return extensionSet(hasRawHtml(source), ALERT_RE.test(source), FOOTNOTE_RE.test(source));
}
