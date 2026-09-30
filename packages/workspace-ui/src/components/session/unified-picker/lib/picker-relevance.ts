import { flattenedLower, wordStartIndex } from './picker-search'

/**
 * How well a row answers a query, so the row the reader meant is one of the
 * first few.
 *
 * The query already decided which rows are listed: each holds every word at a
 * token start (`picker-search.ts`). This decides their order. A row is first
 * placed in a tier by where it matched, then ordered in the tier by a score:
 *
 * - `id` — the query is a task's human id. Nothing else can be meant.
 * - `name` — the words are in what the row is called: a task's title, a
 *   session's name. A name is what a person remembers and types.
 * - `evidence` — the words are only in a task's body or in what was said in a
 *   session. The row is relevant, but it is not the thing that was named.
 *
 * A name that is the query beats one that starts with it, which beats one that
 * holds the query as a phrase, which beats one that holds the words apart. A
 * word that is a whole token beats one that only starts a longer token, so
 * "tab" is "Tab strip", not "table". A short name the words fill beats a long
 * one they only touch. Recency and whether the work is still open decide the
 * rest; their weight is too small to overturn a better match.
 */
export type MatchTier = 'id' | 'name' | 'evidence'

export const MATCH_TIER_ORDER = { id: 3, name: 2, evidence: 1 } satisfies Record<MatchTier, number>

/** One row's standing under a query. Higher is better. */
export interface Relevance {
  tier: MatchTier
  score: number
}

const EXACT = 40
const STARTS_WITH = 25
const PHRASE = 15
const WHOLE_WORD = 6
const WORD_PREFIX = 3
const IN_ORDER = 4
const COVERAGE = 10
const RECENT = 8
const RECENT_HALF_LIFE_MS = 14 * 86_400_000
const CLOSED = 4

function endsToken(text: string, at: number): boolean {
  return at >= text.length || !/[\p{L}\p{N}]/u.test(text[at]!)
}

interface WordMatch {
  at: number
  /** The word is a whole token there, not the start of a longer one. */
  whole: boolean
}

/** Where `word` is a whole token of `text`, else where it first starts one, else -1. */
function bestWordIndex(text: string, word: string): WordMatch {
  let first = -1
  for (let at = wordStartIndex(text, word); at >= 0; at = wordStartIndex(text, word, at + 1)) {
    if (endsToken(text, at + word.length)) return { at, whole: true }
    if (first < 0) first = at
  }
  return { at: first, whole: false }
}

function tokenCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
}

/** How well `name` answers the query's words. Zero when a word is missing. */
export function nameScore(name: string, words: readonly string[]): number {
  const text = flattenedLower(name)
  const phrase = words.join(' ')
  let score = 0
  if (text === phrase) score += EXACT
  else if (text.startsWith(phrase)) score += STARTS_WITH
  else if (words.length > 1 && wordStartIndex(text, phrase) >= 0) score += PHRASE
  let previous = -1
  let inOrder = true
  for (const word of words) {
    const { at, whole } = bestWordIndex(text, word)
    if (at < 0) return 0
    score += whole ? WHOLE_WORD : WORD_PREFIX
    if (at < previous) inOrder = false
    previous = at
  }
  if (words.length > 1 && inOrder) score += IN_ORDER
  return score + COVERAGE * Math.min(1, words.length / Math.max(1, tokenCount(text)))
}

/** The small lift of recent, open work: halves every two weeks, and a closed
 *  task gives some of it back. */
export function activityScore(lastActiveAt: number, now: number, isClosed = false): number {
  const age = Math.max(0, now - lastActiveAt)
  return RECENT * 0.5 ** (age / RECENT_HALF_LIFE_MS) - (isClosed ? CLOSED : 0)
}

/** Better first: tier, then score. Ties are left to the caller's own order. */
export function compareRelevance(a: Relevance, b: Relevance): number {
  return MATCH_TIER_ORDER[b.tier] - MATCH_TIER_ORDER[a.tier] || b.score - a.score
}

/** How many rows Top hits lifts above the sections. */
export const TOP_HIT_COUNT = 3

interface Ranked {
  relevance: Relevance
}

/**
 * The best rows of both kinds, best first, from two lists already in that
 * order. A session whose task is already lifted is left in its section: the
 * task's row opens that session, and two rows with one name spent a place the
 * reader needed. Empty unless a lifted session would otherwise sit below the
 * first few rows — when the sections already open on the best rows, a third
 * heading only moves them down.
 */
export interface TopHits<T, S> {
  tasks: Set<T>
  sessions: Set<S>
  /** Both kinds, in the order they are listed. */
  order: Array<T | S>
}

export function topHits<T extends Ranked & { task: { id: string } }, S extends Ranked>(
  tasks: readonly T[],
  sessions: readonly S[],
  taskIdOf: (session: S) => string | null,
): TopHits<T, S> {
  const none: TopHits<T, S> = { tasks: new Set(), sessions: new Set(), order: [] }
  if (!tasks.length || !sessions.length) return none
  const picked: TopHits<T, S> = { tasks: new Set(), sessions: new Set(), order: [] }
  const liftedTaskIds = new Set<string>()
  let isBuried = false
  let taskAt = 0
  let sessionAt = 0
  while (picked.order.length < TOP_HIT_COUNT && (taskAt < tasks.length || sessionAt < sessions.length)) {
    const task = tasks[taskAt]
    const session = sessions[sessionAt]
    // A tie goes to the task: its row resumes its latest session.
    if (task && (!session || compareRelevance(task.relevance, session.relevance) <= 0)) {
      taskAt += 1
      picked.tasks.add(task)
      picked.order.push(task)
      liftedTaskIds.add(task.task.id)
      continue
    }
    sessionAt += 1
    const taskId = taskIdOf(session!)
    if (taskId && liftedTaskIds.has(taskId)) continue
    picked.sessions.add(session!)
    picked.order.push(session!)
    if (taskId) liftedTaskIds.add(taskId)
    // Under the sections it would follow every task.
    if (tasks.length + sessionAt > TOP_HIT_COUNT) isBuried = true
  }
  return isBuried ? picked : none
}
