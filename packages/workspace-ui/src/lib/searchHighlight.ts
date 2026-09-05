// Shared by every surface that filters a list on a literal query and wants to
// show *why* a row matched: the workspace ledger and the session picker.

/** One run of a row's text, flagged when it is part of the active query so the
 *  row can `<mark>` it without the markup doing the matching. */
export type TextRun = { text: string; hit: boolean };

/** Split `text` on every case-insensitive occurrence of `query`. An empty or
 *  absent query yields the single unhighlighted run, so callers never branch. */
export function highlightRuns(text: string, query: string): TextRun[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const runs: TextRun[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) runs.push({ text: text.slice(from, at), hit: false });
    runs.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), hit: false });
  return runs.length ? runs : [{ text, hit: false }];
}

/** Like `highlightRuns`, but every whitespace-separated word of `query` is a
 *  hit on its own. For text a full-text index matched, where the words are
 *  ANDed and need not sit next to each other. */
export function highlightWordRuns(text: string, query: string): TextRun[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [{ text, hit: false }];
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const runs: TextRun[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > from) runs.push({ text: text.slice(from, match.index), hit: false });
    runs.push({ text: match[0], hit: true });
    from = match.index + match[0].length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), hit: false });
  return runs.length ? runs : [{ text, hit: false }];
}
