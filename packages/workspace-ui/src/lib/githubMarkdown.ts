import type { MarkedExtension } from "@humanspeak/svelte-markdown";
import { markedAlert } from "@humanspeak/svelte-markdown/extensions/alert";

export const githubMarkdownExtensions: MarkedExtension[] = [markedAlert()];

export interface MarkdownMediaLink {
  href: string;
  provider: string;
}

const GITHUB_MEDIA_HOSTS = new Set([
  "github.com",
  "githubusercontent.com",
  "objects.githubusercontent.com",
]);

function mediaProvider(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    GITHUB_MEDIA_HOSTS.has(hostname) ||
    hostname.endsWith(".githubusercontent.com") ||
    (/^gh-file-drop-api-prod-/.test(hostname) &&
      hostname.endsWith(".pinglabs.workers.dev"))
  ) {
    return "GitHub";
  }
  return hostname;
}

function standaloneMediaHref(raw: string): string | null {
  const paragraph = raw.trim();
  if (/^https?:\/\/\S+$/i.test(paragraph)) return paragraph;

  // Some generated PR bodies use image syntax for recordings. The Markdown
  // parser then emits an <img>, which can only fail for an MP4/MOV and leaves
  // the alt text in a broken-image frame. Unwrap only a whole image paragraph.
  const image = paragraph.match(
    /^!\[[^\]\r\n]*\]\(\s*(https?:\/\/\S+?)\s*\)$/i,
  );
  return image?.[1] ?? null;
}

/**
 * GitHub recordings can arrive as a bare URL or as image syntax. Recognize
 * only a paragraph made entirely from that media reference; an inline or
 * deliberately labelled link must keep the author's wording.
 */
export function standaloneMarkdownMediaLink(raw: string): MarkdownMediaLink | null {
  const href = standaloneMediaHref(raw);
  if (!href) return null;

  try {
    const url = new URL(href);
    const isDirectVideo = /\.(?:mp4|mov)$/i.test(url.pathname);
    const isGithubAttachment =
      url.hostname.toLowerCase().replace(/^www\./, "") === "github.com" &&
      url.pathname.startsWith("/user-attachments/assets/");
    if (!isDirectVideo && !isGithubAttachment) return null;
    return { href: url.href, provider: mediaProvider(url) };
  } catch {
    return null;
  }
}

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
