/** The document's own byline, sitting under its H1 — the one place the design
 *  keeps the reading stats, now that they have left the header.
 *
 *  Returned CSS-quoted (or `none`) because it is consumed by `content:` on the
 *  H1's ::after, which is the only way to hang it off a heading the editor
 *  owns without reaching into the document itself. */
export function bylineContent(words: number): string {
  if (words <= 0) return "none";
  // 200 wpm is the usual silent-reading figure; never round a real document to
  // "0 min".
  const minutes = Math.max(1, Math.round(words / 200));
  return `"${words.toLocaleString()} words · ${minutes} min read"`;
}
