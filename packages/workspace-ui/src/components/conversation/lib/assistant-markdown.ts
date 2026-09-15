import type { SvelteMarkdownOptions } from "@humanspeak/svelte-markdown";
import { rawHtmlMarkedExtension } from "./raw-html";
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

const rawHtmlExtensions = [rawHtmlMarkedExtension];
const plainExtensions: typeof rawHtmlExtensions = [];

/** Raw HTML can merge adjacent blocks and requires the full parser. Ordinary
 * prose and fenced source use the library's stable-prefix incremental parser. */
export function assistantMarkdownExtensions(source: string) {
  let fence: string | undefined;
  for (const line of source.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (!fence && line.includes("<")) {
      return rawHtmlExtensions;
    }
  }
  return plainExtensions;
}
