import type { SvelteMarkdownOptions } from "@humanspeak/svelte-markdown";
import { decodeHtmlEntities } from "./html-entities";

// Parser hooks disable svelte-markdown's append-only tail window. Keep the
// assistant configuration hook-free so a streamed response only reparses its
// changing tail.
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
