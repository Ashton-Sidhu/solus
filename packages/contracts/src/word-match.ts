/**
 * The word rule every search in Solus applies (docs/plans/unified-search.md):
 * a query is split on white space, and every word must start a word of the
 * text. Case is ignored; nothing is stemmed. The client's pass over task and
 * session names and the hosts' indexes read a query the same way, so one query
 * means one thing in every section and the marks in a row agree with the hit.
 */

/** The query's words, lower-cased. A word with no letter or digit starts no
 *  word of any text, so it is dropped. Empty for a blank query. */
export function queryWords(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
}

/** A word of the text starts at the start or after a character that is neither
 *  a letter nor a digit — the boundary of the index's unicode61 tokenizer. */
function startsWord(text: string, at: number): boolean {
  return at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!)
}

/** Where `word` first starts a word of `lowerText`, or -1. The caller
 *  lower-cases the text once, not once per word. */
export function wordStartIndex(lowerText: string, word: string, from = 0): number {
  let at = lowerText.indexOf(word, from)
  while (at >= 0 && !startsWord(lowerText, at)) at = lowerText.indexOf(word, at + 1)
  return at
}

/** True when every word starts a word of the lower-cased text. No words match everything. */
export function holdsEveryWord(lowerText: string, words: readonly string[]): boolean {
  return words.every((word) => wordStartIndex(lowerText, word) >= 0)
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u
/** Characters of context kept before the first hit, and the passage's length. */
const PASSAGE_LEAD = 80
const PASSAGE_LENGTH = 320

/**
 * The passage of `text` around the first place a query word starts a word,
 * white space collapsed, with each matched word wrapped in `open` and `close`
 * — to the end of the word it starts, as an index marks a prefix hit. A
 * caller that cannot mark passes empty markers. The passage opens at the
 * text's start when no word is found.
 */
export function markedPassage(text: string, words: readonly string[], open: string, close: string): string {
  const lower = text.toLocaleLowerCase()
  const spans: Array<[number, number]> = []
  // Lower-casing can change a string's length; its positions then do not map.
  if (lower.length === text.length) {
    for (const word of words) {
      for (let at = wordStartIndex(lower, word); at >= 0; at = wordStartIndex(lower, word, at + 1)) {
        let end = at + word.length
        while (end < text.length && WORD_CHARACTER.test(text[end]!)) end++
        spans.push([at, end])
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const first = spans[0]?.[0] ?? 0
  let start = Math.max(0, first - PASSAGE_LEAD)
  // Open and close on a word boundary, never inside one.
  while (start > 0 && start < first && WORD_CHARACTER.test(text[start - 1]!)) start++
  let end = Math.min(text.length, start + PASSAGE_LENGTH)
  while (end < text.length && WORD_CHARACTER.test(text[end]!)) end++
  let passage = start > 0 ? '…' : ''
  let from = start
  for (const [at, spanEnd] of spans) {
    if (at < from || at >= end) continue
    passage += `${text.slice(from, at)}${open}${text.slice(at, Math.min(spanEnd, end))}${close}`
    from = Math.min(spanEnd, end)
  }
  passage += text.slice(from, end) + (end < text.length ? '…' : '')
  return passage.replace(/\s+/g, ' ').trim()
}
