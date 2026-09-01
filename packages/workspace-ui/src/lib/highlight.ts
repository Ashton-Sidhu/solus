import { toHtml } from "hast-util-to-html";
import { lowlight } from "./lowlight";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Tokenising with lowlight is expensive and the same content is highlighted
// repeatedly — re-renders, tab switches, scroll-back, and identical snippets all
// re-call this with unchanged text. Cache the rendered HTML keyed on lang+text.
// Bounded FIFO eviction keeps memory flat (streaming a block produces a new key
// per frame, so without a cap the map would grow unbounded during a long turn).
// Entries retain both the source key and its 3-5× larger HTML, so the bound is
// on total characters, not entry count — a handful of giant blocks would
// otherwise hold tens of MB. Oversized blocks are highlighted but never cached.
const CACHE_MAX_ENTRIES = 500;
const CACHE_MAX_ENTRY_CHARS = 50_000;
const CACHE_MAX_TOTAL_CHARS = 4_000_000;
const cache = new Map<string, string>();
let cacheChars = 0;

function evictOldest(): void {
  const oldest = cache.keys().next().value;
  if (oldest === undefined) return;
  const html = cache.get(oldest);
  cache.delete(oldest);
  cacheChars -= oldest.length + (html?.length ?? 0);
}

function memoize(key: string, html: string): string {
  if (key.length > CACHE_MAX_ENTRY_CHARS) return html;
  cache.set(key, html);
  cacheChars += key.length + html.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheChars > CACHE_MAX_TOTAL_CHARS) evictOldest();
  return html;
}

/**
 * Highlight `text` for the given language, returning hljs-tokenised HTML safe
 * for `{@html}`. Unknown/missing languages fall back to plain escaped text.
 */
export function highlightCode(text: string, lang?: string): string {
  const normalized = lang?.toLowerCase().trim();
  const key = `${normalized ?? ""} ${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (normalized && lowlight.registered(normalized)) {
    try {
      return memoize(key, toHtml(lowlight.highlight(normalized, text)));
    } catch {
      // fall through to plain rendering
    }
  }
  return memoize(key, escapeHtml(text));
}
