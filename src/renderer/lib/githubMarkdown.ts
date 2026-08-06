import type { MarkedExtension } from "@humanspeak/svelte-markdown";
import { markedAlert } from "@humanspeak/svelte-markdown/extensions/alert";

export const githubMarkdownExtensions: MarkedExtension[] = [markedAlert()];

const HTML_ENTITY = /&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
let entityDecoder: HTMLTextAreaElement | null = null;

/**
 * GitHub bodies carry HTML entities — `&nbsp;` around a logo, `&amp;` in a
 * title. marked leaves them in the text token because its own output is an HTML
 * string, where the browser decodes them on parse. We render text into DOM text
 * nodes instead, so the entity would survive to the screen ("Deploying
 * with&nbsp;"). A detached textarea decodes it: its content is RCDATA, so
 * entities resolve while tags stay text — `&lt;script&gt;` comes back as the
 * literal string, which Svelte then escapes again on render.
 */
export function decodeHtmlEntities(text: string): string {
  if (!HTML_ENTITY.test(text)) return text;
  entityDecoder ??= document.createElement("textarea");
  entityDecoder.innerHTML = text;
  return entityDecoder.value;
}
