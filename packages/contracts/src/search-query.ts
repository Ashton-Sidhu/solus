/**
 * The word rule every search in Solus applies (docs/plans/unified-search.md):
 * punctuation and coding boundaries split words, and every query word must
 * start a word of the text. Case and accents are ignored; numbers match whole
 * tokens and nothing is stemmed. Session names, task titles, bodies and
 * comments, the hosts' indexes and the marks in a row all read a query through
 * one `SearchQuery`, so one query means one thing everywhere.
 */

export interface SearchToken { text: string; start: number; end: number }

interface PreparedText { tokens: readonly SearchToken[]; words: Set<string>; text: string; joined: string }
const tokenCache = new Map<string, PreparedText>()
const WORDS = /\p{Lu}+(?=\p{Lu}\p{Ll}|[^\p{L}]|$)|\p{Lu}?[\p{Ll}\p{M}]+|[\p{L}\p{M}]+|\p{N}+/gu
// Most words are ASCII, where folding is only lower-casing; normalizing every
// word of a long body was most of the time a list took to build.
const ASCII = /^[A-Za-z0-9]*$/
const fold = (text: string) => ASCII.test(text) ? text.toLowerCase() : text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

function prepare(text: string): PreparedText {
  const cached = tokenCache.get(text)
  if (cached) return cached
  const tokens = Array.from(text.matchAll(WORDS), match => ({ text: fold(match[0]), start: match.index, end: match.index + match[0].length }))
  const words = tokens.map(token => token.text)
  const prepared = { tokens, words: new Set(words), text: words.join(' '), joined: words.join('') }
  // Cache names and queries, without retaining large transcript bodies.
  if (text.length <= 1024) {
    if (tokenCache.size >= 8192) tokenCache.delete(tokenCache.keys().next().value!)
    tokenCache.set(text, prepared)
  }
  return prepared
}

/** The words of `text`, folded, with where each one is in `text`. */
export function searchTokens(text: string): readonly SearchToken[] { return prepare(text).tokens }

/** Letters and digits written together that the word rule splits into
 *  several words: `defaultMergeMethod`, `JSONSchema`, `t3code`. */
const JOINED_RUN = /[\p{L}\p{M}\p{N}]+/gu

/** Each run of several words written together, folded as one word, so a
 *  person who types an identifier in lower case as one word still finds it. */
export function joinedRuns(text: string): SearchToken[] {
  const runs: SearchToken[] = []
  for (const match of text.matchAll(JOINED_RUN)) {
    // Counted without the token cache: transcripts hold far more runs than names.
    if ((match[0].match(WORDS)?.length ?? 0) < 2) continue
    runs.push({ text: fold(match[0]), start: match.index, end: match.index + match[0].length })
  }
  return runs
}

/** This exact text is indexed by both database engines; no stemming. The
 *  joined runs go last, so they never split a phrase of the words. */
export function searchText(text: string): string {
  const words = prepare(text).text
  const runs = joinedRuns(text)
  return runs.length ? `${words} ${runs.map(run => run.text).join(' ')}` : words
}

/** Numeric words are exact; other words may be prefixes as the person types. */
export function searchTokenMatches(token: string, word: string): boolean {
  return /^\d+$/.test(word) ? token === word : token.startsWith(word)
}

const FILLER_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with'])

function oneEdit(left: string, right: string): boolean {
  if (left.length < 4 || /\d/.test(left) || left[0] !== right[0] || Math.abs(left.length - right.length) > 1) return false
  let a = 0, b = 0, edits = 0
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) { a++; b++; continue }
    if (++edits > 1) return false
    if (left[a] === right[b + 1] && left[a + 1] === right[b]) { a += 2; b += 2 }
    else if (left.length > right.length) a++
    else if (right.length > left.length) b++
    else { a++; b++ }
  }
  return edits + Number(a < left.length || b < right.length) <= 1
}

/** Whether `word` is several of the field's words typed together, from a
 *  word start: "vscode" in "VS Code", "fixsid" in "Fix sidebar". */
function joinsWords(field: PreparedText, word: string): boolean {
  // Words typed together are in the words written together; most names fail here.
  if (!field.joined.includes(word)) return false
  for (let first = 0; first < field.tokens.length; first++) {
    let rest = word
    for (let at = first; at < field.tokens.length && rest; at++) {
      const token = field.tokens[at]!.text
      if (at > first && token.startsWith(rest)) return true
      if (!rest.startsWith(token)) break
      rest = rest.slice(token.length)
      if (!rest && at > first) return true
    }
  }
  return false
}

/** How `field` holds `word`: as a whole word, as the start of one or as
 *  several typed together, or not at all. Numbers are whole words only. */
function holds(field: PreparedText, word: string): 'whole' | 'part' | null {
  if (field.words.has(word)) return 'whole'
  if (/^\d+$/.test(word)) return null
  let at = field.text.indexOf(word)
  while (at > 0 && field.text[at - 1] !== ' ') at = field.text.indexOf(word, at + 1)
  return at >= 0 || joinsWords(field, word) ? 'part' : null
}

function nameQuality(field: PreparedText, words: readonly string[], whole: number): number {
  const phrase = words.join(' ')
  const position = field.text.indexOf(phrase)
  const phraseMatch = position >= 0 && (position === 0 || field.text[position - 1] === ' ')
  const quality = field.text === phrase ? 90 : phraseMatch && position === 0 ? 70 : phraseMatch ? 60 : 50
  return quality + whole / words.length * 8 + Math.min(1, words.length / field.tokens.length) * 2
}

export interface NameMatch { score: number; typo: boolean }

const WORD_CHARACTER = /[\p{L}\p{N}]/u
/** Characters of context kept before the first hit, and the passage's length. */
const PASSAGE_LEAD = 80
const PASSAGE_LENGTH = 320

/** A query, read once, asked of each text it is matched against. */
export class SearchQuery {
  /** The query's words, folded. A word with no letter or digit is dropped. */
  readonly words: readonly string[]
  /** The words a text must hold: a filler word ("the" in "fix the sidebar")
   *  is optional unless the query is only filler. It still counts where it matches. */
  readonly required: readonly string[]
  /** The pull request a query names as "pr 22889", "pull request 22889" or a
   *  pasted ".../pull/22889" link, as a query of its number. "#22889" already
   *  reads as the number. */
  readonly pullRequest: SearchQuery | null

  constructor(readonly text: string) {
    this.words = prepare(text).tokens.map(token => token.text)
    // The same array when nothing is optional: a name match then reads the words without a copy.
    const optional = this.words.some(word => FILLER_WORDS.has(word)) && this.words.some(word => !FILLER_WORDS.has(word))
    this.required = optional ? this.words.filter(word => !FILLER_WORDS.has(word)) : this.words
    const number = this.words.at(-1)
    const before = this.words.at(-2)
    const namesPullRequest = !!number && /^\d+$/.test(number) && (before === 'pr' || before === 'pull' || before === 'pulls' || (before === 'request' && this.words.at(-3) === 'pull'))
    this.pullRequest = namesPullRequest ? new SearchQuery(number) : null
  }

  get isEmpty(): boolean { return this.words.length === 0 }

  /** How well `text` names what the query asks for: exact name, phrase, whole
   *  words, prefixes, words typed together, then, with `typos`, one edit.
   *  Null when a required word is missing. */
  matchName(text: string, typos = false): NameMatch | null {
    if (this.isEmpty) return null
    const field = prepare(text)
    if (!field.tokens.length) return null
    // A filler word the name holds still counts toward its quality.
    const words = this.required === this.words ? this.words : this.words.filter(word => field.words.has(word) || this.required.includes(word))
    let whole = 0, typo = false
    for (const word of words) {
      const held = holds(field, word)
      if (held === 'whole') whole++
      if (held) continue
      if (!typos || !field.tokens.some(({ text: token }) => oneEdit(word, token.slice(0, word.length + Number(token.length > word.length))))) return null
      typo = true
    }
    if (typo) return { score: 10 + whole, typo: true }
    return { score: nameQuality(field, words, whole), typo: false }
  }

  /** Where the query's words start words of `text`, in order: each matching
   *  word to its end, as an index marks a prefix hit, and a whole identifier
   *  for a word typed as several written together ("defaultmergemethod"). */
  hits(text: string): SearchToken[] {
    const spans: SearchToken[] = []
    const unmatched = new Set(this.words)
    for (const token of searchTokens(text)) {
      let matched = false
      for (const word of this.words) {
        if (!searchTokenMatches(token.text, word)) continue
        matched = true
        unmatched.delete(word)
      }
      if (matched) spans.push(token)
    }
    if (unmatched.size) for (const run of joinedRuns(text)) {
      if ([...unmatched].some(word => searchTokenMatches(run.text, word))) spans.push(run)
    }
    return spans.sort((a, b) => a.start - b.start || b.end - a.end)
  }

  /** How many required words `text` holds, by the rule names follow. */
  heldWords(text: string): number {
    const field = prepare(text)
    return this.required.filter(word => holds(field, word)).length
  }

  /** True when `text` holds every required word. An empty query holds nothing. */
  holdsEveryWord(text: string): boolean {
    if (this.isEmpty) return false
    const field = prepare(text)
    return this.required.every(word => holds(field, word))
  }

  /** Where the first word of the query starts in `text`, or -1. A list reads
   *  this for every row on each keystroke, so it searches the folded words as
   *  one string; an identifier typed as one word is looked for only when no
   *  word starts a word of the text. */
  firstHit(text: string): number {
    const field = prepare(text)
    let earliest = -1
    for (const word of this.words) {
      const number = /^\d+$/.test(word)
      let at = field.text.indexOf(word)
      while (at >= 0 && !((at === 0 || field.text[at - 1] === ' ') && (!number || (field.text[at + word.length] ?? ' ') === ' '))) at = field.text.indexOf(word, at + 1)
      if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at
    }
    if (earliest < 0) return joinedRuns(text).find(run => this.words.some(word => searchTokenMatches(run.text, word)))?.start ?? -1
    // The folded words are joined by one space: the spaces before a hit count the words before it.
    let index = 0
    for (let at = 0; at < earliest; at++) if (field.text.charCodeAt(at) === 32) index++
    return field.tokens[index]!.start
  }

  /** The passage of `text` around the first hit, white space collapsed, with
   *  each hit wrapped in `open` and `close`. A caller that cannot mark passes
   *  empty markers. The passage opens at the text's start when nothing is hit. */
  passage(text: string, open: string, close: string): string {
    const spans = this.hits(text)
    const first = spans[0]?.start ?? 0
    let start = Math.max(0, first - PASSAGE_LEAD)
    // Open and close on a word boundary, never inside one.
    while (start > 0 && start < first && WORD_CHARACTER.test(text[start - 1]!)) start++
    let end = Math.min(text.length, start + PASSAGE_LENGTH)
    while (end < text.length && WORD_CHARACTER.test(text[end]!)) end++
    let passage = start > 0 ? '…' : ''
    let from = start
    for (const { start: at, end: spanEnd } of spans) {
      if (at < from || at >= end) continue
      passage += `${text.slice(from, at)}${open}${text.slice(at, Math.min(spanEnd, end))}${close}`
      from = Math.min(spanEnd, end)
    }
    passage += text.slice(from, end) + (end < text.length ? '…' : '')
    return passage.replace(/\s+/g, ' ').trim()
  }
}
