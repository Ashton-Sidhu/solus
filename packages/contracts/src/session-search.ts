/** The matching and ranking rules shared by hosts, workspace services and clients. */
export interface SearchToken { text: string; start: number; end: number }
export interface SessionSearchReason { field: 'id' | 'title' | 'branch' | 'pullRequest' | 'messages'; text: string }
/** A provider identity when available, with text and time for histories without one.
 * This reference survives a derived-index rebuild and a copy to another host. */
export interface SessionSearchTarget {
  sourceSessionId: string
  messageId: string | null
  role: string
  timestamp: number
  text: string
}

interface PreparedText { tokens: readonly SearchToken[]; words: Set<string>; text: string; joined: string }
const tokenCache = new Map<string, PreparedText>()
const WORDS = /\p{Lu}+(?=\p{Lu}\p{Ll}|[^\p{L}]|$)|\p{Lu}?[\p{Ll}\p{M}]+|[\p{L}\p{M}]+|\p{N}+/gu
const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

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

export function searchTokens(text: string): readonly SearchToken[] { return prepare(text).tokens }

/** This exact text is indexed by both database engines; no stemming. */
export function searchText(text: string): string { return prepare(text).text }

/** Tool output and provider-child rows do not belong to the searchable conversation. */
export function searchableMessageText(message: { role?: string; content?: string; toolName?: string; parentToolUseId?: string } | null): string {
  return message && (message.role === 'user' || message.role === 'assistant') && !message.toolName && !message.parentToolUseId
    ? searchText(message.content ?? '') : ''
}

export function searchWords(query: string): string[] { return prepare(query).tokens.map(token => token.text) }

/** Numeric queries are exact; words may still be prefixes as the user types. */
export function searchTokenMatches(token: string, word: string): boolean {
  return /^\d+$/.test(word) ? token === word : token.startsWith(word)
}

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

export interface SearchNameMatch { score: number; typo: boolean }

function nameQuality(field: PreparedText, words: readonly string[], whole: number): number {
  const phrase = words.join(' ')
  const position = field.text.indexOf(phrase)
  const phraseMatch = position >= 0 && (position === 0 || field.text[position - 1] === ' ')
  const quality = field.text === phrase ? 90 : phraseMatch && position === 0 ? 70 : phraseMatch ? 60 : 50
  return quality + whole / words.length * 8 + Math.min(1, words.length / field.tokens.length) * 2
}

/** Exact name, phrase, whole words, prefixes, joined words, then a one-edit name. */
export function searchName(text: string, words: readonly string[], typos = false): SearchNameMatch | null {
  if (!words.length) return null
  const field = prepare(text)
  if (!field.tokens.length) return null
  const normalized = field.text
  let whole = 0, typo = false
  for (const word of words) {
    if (field.words.has(word)) { whole++; continue }
    if (!/^\d+$/.test(word)) {
      let at = normalized.indexOf(word)
      while (at > 0 && normalized[at - 1] !== ' ') at = normalized.indexOf(word, at + 1)
      if (at >= 0) continue
    }
    if (words.length === 1 && field.joined === word) return { score: 35, typo: false }
    if (!typos || !field.tokens.some(({ text: token }) => oneEdit(word, token.slice(0, word.length + Number(token.length > word.length))))) return null
    typo = true
  }
  if (typo) return { score: 10 + whole, typo: true }
  return { score: nameQuality(field, words, whole), typo: false }
}

export interface SessionSearchSubject { id?: string; title: string | null; branch?: string | null; pullRequest?: string | null }
export interface SessionNameScore { score: number; reason: SessionSearchReason; typo: boolean }

export function sessionNameScore(subject: SessionSearchSubject, words: readonly string[], typos = false): SessionNameScore | null {
  // An exact ID was already checked before a names-only correction pass.
  if (!typos && subject.id && subject.id.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === words.join('')) return { score: 700, reason: { field: 'id', text: subject.id }, typo: false }
  if (!subject.title && !subject.branch && !subject.pullRequest) return null
  let best: SessionNameScore | null = null
  for (const [field, text] of [['title', subject.title], ['branch', subject.branch], ['pullRequest', subject.pullRequest]] as const) {
    if (!text) continue
    const match = searchName(text, words, typos)
    if (!match) continue
    const score = match.typo ? 50 + match.score : (field === 'title' ? 400 : 300) + match.score
    if (!best || score > best.score) best = { score, reason: { field, text }, typo: match.typo }
  }
  return best
}

/** Counts saturate and do not depend on the size of one host's corpus. */
export function sessionEvidenceScore(counts: readonly number[], together: boolean, phrase: boolean): number {
  const frequency = counts.reduce((sum, count) => sum + count / (count + 1.2), 0) / Math.max(1, counts.length)
  return (phrase ? 250 : together ? 200 : 100) + frequency * 10
}

/** Bounded below a match-quality step. The caller uses one clock for all hosts. */
export function searchActivityScore(timestamp: number, now: number): number {
  return 2 * 0.5 ** (Math.max(0, now - timestamp) / (14 * 86_400_000))
}

export function searchTargetMatches(target: SessionSearchTarget, message: { messageId?: string; id?: string; role: string; content: string; timestamp?: number; sourceSessionId?: string }): boolean {
  if (message.sourceSessionId && message.sourceSessionId !== target.sourceSessionId) return false
  if (target.messageId && (message.messageId === target.messageId || message.id === target.messageId)) {
    return true
  }
  return message.role === target.role && message.content.startsWith(target.text) && (message.timestamp === undefined || Math.abs(message.timestamp - target.timestamp) < 1000)
}
