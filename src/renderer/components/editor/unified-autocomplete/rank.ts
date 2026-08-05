/*
 * Matching and ranking. Lower scores win:
 *
 *   0    title prefix
 *   1    title match on a word boundary
 *   2    title substring
 *   4+   fuzzy subsequence, plus 0.05 per gap
 *   9+   metadata or kind-name match
 *
 * Ties break on the caller's own order, which every index supplies as recency.
 * Highlighting falls out of the same pass — a metadata-only match highlights
 * nothing, because none of the title's characters were what matched.
 */

export interface TitlePart {
  text: string;
  hit: boolean;
}

export interface Match {
  score: number;
  ranges: [number, number][];
}

export interface Ranked<T> {
  item: T;
  score: number;
  parts: TitlePart[];
}

const WORD_BOUNDARY = /[\s_\-/.:#(]/;

export function fuzzy(text: string, query: string): Match | null {
  if (!query) return { score: 0, ranges: [] };
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  const at = haystack.indexOf(needle);
  if (at >= 0) {
    const score =
      at === 0 ? 0 : WORD_BOUNDARY.test(haystack.charAt(at - 1)) ? 1 : 2;
    return { score, ranges: [[at, at + needle.length]] };
  }

  const ranges: [number, number][] = [];
  let cursor = 0;
  let gaps = 0;
  for (const char of needle) {
    if (char === " ") continue;
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return null;
    const previous = ranges.at(-1);
    if (previous && previous[1] === found) previous[1] = found + 1;
    else {
      ranges.push([found, found + 1]);
      if (ranges.length > 1) gaps++;
    }
    cursor = found + 1;
  }
  return { score: 4 + gaps * 0.05, ranges };
}

export function highlightParts(
  text: string,
  ranges: readonly [number, number][],
): TitlePart[] {
  if (ranges.length === 0) return [{ text, hit: false }];
  const parts: TitlePart[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push({ text: text.slice(at, from), hit: false });
    parts.push({ text: text.slice(from, to), hit: true });
    at = to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

export interface Rankable {
  title: string;
  meta: string;
  /** Included in the metadata pass so "#pull request" finds PRs by their noun. */
  kindNoun?: string;
}

/** Rank `items` against `query`, dropping non-matches. An empty query keeps all. */
export function rank<T extends Rankable>(
  items: readonly T[],
  query: string,
): Ranked<T>[] {
  if (!query)
    return items.map((item) => ({
      item,
      score: 0,
      parts: [{ text: item.title, hit: false }],
    }));

  const ranked: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const onTitle = fuzzy(item.title, query);
    let score: number;
    let ranges: [number, number][] = [];
    if (onTitle) {
      score = onTitle.score;
      ranges = onTitle.ranges;
    } else {
      // Metadata is a weaker signal, so only a prefix or word-boundary hit in it
      // earns a row. A fuzzy subsequence across metadata matches almost anything.
      const haystack = item.kindNoun
        ? `${item.meta} ${item.kindNoun}`
        : item.meta;
      const onMeta = fuzzy(haystack, query);
      if (!onMeta || onMeta.score > 1) return;
      score = 9 + onMeta.score;
    }
    ranked.push({
      item,
      score: score + index * 0.001,
      parts: highlightParts(item.title, ranges),
    });
  });
  return ranked.sort((left, right) => left.score - right.score);
}
