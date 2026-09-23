/**
 * The pull request list's search field, read the way a code host reads it.
 *
 * A typed query is split into the qualifiers the list understands — written
 * GitHub's way, `label:bug`, `-label:"needs design"`, `author:me`, `draft:true`,
 * `review:approved`, `status:success` — and the text that is left. The same
 * parse drives two things: the search the host is asked for (`hostSearchQuery`)
 * and the narrowing of the rows already on screen while that answer is on its
 * way (`matchesPrQualifiers`, `matchesPrText`).
 */
import type { PullRequest } from '@solus/contracts/providers'

export type PrSearchReview = 'approved' | 'changes-requested' | 'review-required' | 'none'
export type PrSearchChecks = 'passing' | 'failing'

export interface PrSearchQualifiers {
  /** Each inner list is one `label:` qualifier; a row needs one name from each. */
  labels?: string[][]
  excludedLabels?: string[]
  /** A login, or `me` for the viewer. */
  author?: string
  draft?: 'only' | 'hide'
  review?: PrSearchReview
  checks?: PrSearchChecks
}

export interface PrSearchQuery {
  text: string
  qualifiers: PrSearchQualifiers
}

/** What `review:` takes, in GitHub's spelling and in the list's. */
const REVIEW_VALUES = new Map<string, PrSearchReview>([
  ['approved', 'approved'],
  ['changes_requested', 'changes-requested'],
  ['changes-requested', 'changes-requested'],
  ['required', 'review-required'],
  ['review-required', 'review-required'],
  ['none', 'none'],
])

/** What `status:` (or `checks:`) takes. */
const CHECKS_VALUES = new Map<string, PrSearchChecks>([
  ['success', 'passing'],
  ['passing', 'passing'],
  ['failure', 'failing'],
  ['failing', 'failing'],
])

/** A run of non-space characters where a quoted stretch stays whole, so
 *  `label:"needs design"` is one token. */
const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/g
const MAX_QUALIFIER_VALUES = 10
const MAX_QUALIFIER_LENGTH = 200

function qualifierValue(raw: string): string {
  return raw.replaceAll('"', '').trim()
}

/** `label:a,b` is GitHub's OR; a quoted value is one name whatever it holds. */
function splitQualifierList(raw: string): string[] {
  if (/^\s*"[^"]*"\s*$/.test(raw)) {
    const whole = qualifierValue(raw)
    return whole.length === 0 ? [] : [whole]
  }
  return raw.split(',').map(qualifierValue).filter((part) => part.length > 0)
}

function boundedNames(names: string[]): string[] {
  return names
    .slice(0, MAX_QUALIFIER_VALUES)
    .map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim())
    .filter((name) => name.length > 0)
}

/**
 * Split a typed query into qualifiers and text.
 *
 * An unknown key is read as a namespaced label — `size:XXL`, `area:web` — which
 * is what someone typing one almost always means. Quoting is the way back to
 * plain text, and a known key with a value it does not take stays text too.
 */
export function parsePrSearchQuery(raw: string): PrSearchQuery {
  const text: string[] = []
  const labels: string[][] = []
  const excludedLabels: string[] = []
  const qualifiers: PrSearchQualifiers = {}
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(token)
    const read = qualifier ? readQualifier(qualifier[2], qualifier[3], qualifier[1] === '-', qualifiers) : null
    if (read === null) text.push(token)
    else if (read.negated) excludedLabels.push(...read.labels)
    else if (read.labels.length > 0) labels.push(read.labels)
  }
  if (labels.length > 0) qualifiers.labels = labels.slice(0, MAX_QUALIFIER_VALUES)
  if (excludedLabels.length > 0) qualifiers.excludedLabels = excludedLabels.slice(0, MAX_QUALIFIER_VALUES)
  return { text: text.join(' '), qualifiers }
}

/**
 * One `key:value` token. A non-label qualifier is written straight onto
 * `qualifiers`; labels are handed back for the caller to collect. Null means
 * the token is not a qualifier this list takes, and stays text.
 */
function readQualifier(
  name: string,
  rawValue: string,
  negated: boolean,
  qualifiers: PrSearchQualifiers,
): { labels: string[]; negated: boolean } | null {
  const value = qualifierValue(rawValue)
  if (value.length === 0) return null
  const none = { labels: [], negated: false }
  switch (name.toLowerCase()) {
    case 'label':
      return labelsOf(splitQualifierList(rawValue), negated)
    case 'author':
      if (negated) return null
      qualifiers.author = value.slice(0, MAX_QUALIFIER_LENGTH).trim()
      return none
    case 'draft': {
      const flag = value.toLowerCase()
      if (negated || (flag !== 'true' && flag !== 'false')) return null
      qualifiers.draft = flag === 'true' ? 'only' : 'hide'
      return none
    }
    case 'review': {
      const decision = negated ? undefined : REVIEW_VALUES.get(value.toLowerCase())
      if (!decision) return null
      qualifiers.review = decision
      return none
    }
    case 'status':
    case 'checks': {
      const state = negated ? undefined : CHECKS_VALUES.get(value.toLowerCase())
      if (!state) return null
      qualifiers.checks = state
      return none
    }
    default:
      // A pasted link is not a label: `https://…` would otherwise become one.
      if (value.startsWith('/')) return null
      return labelsOf(
        splitQualifierList(rawValue).map((part) => (part.includes(':') ? part : `${name}:${part}`)),
        negated,
      )
  }
}

function labelsOf(names: string[], negated: boolean): { labels: string[]; negated: boolean } | null {
  const labels = boundedNames(names)
  return labels.length > 0 ? { labels, negated } : null
}

const GITHUB_REVIEW = {
  approved: 'approved',
  'changes-requested': 'changes_requested',
  'review-required': 'required',
  none: 'none',
} satisfies Record<PrSearchReview, string>

function quoted(name: string): string {
  return `"${name.replaceAll('"', '')}"`
}

/**
 * The query the code host is asked, in GitHub's own search syntax. Empty when
 * nothing was typed, which is the signal to read the ordinary listing instead.
 * `author:me` becomes GitHub's `author:@me`, so the host resolves who "me" is.
 */
export function hostSearchQuery(query: PrSearchQuery): string {
  const { qualifiers } = query
  const parts: string[] = []
  for (const group of qualifiers.labels ?? []) parts.push(`label:${group.map(quoted).join(',')}`)
  for (const name of qualifiers.excludedLabels ?? []) parts.push(`-label:${quoted(name)}`)
  if (qualifiers.author) {
    parts.push(`author:${qualifiers.author.toLowerCase() === 'me' ? '@me' : qualifiers.author}`)
  }
  if (qualifiers.draft) parts.push(`draft:${qualifiers.draft === 'only'}`)
  if (qualifiers.review) parts.push(`review:${GITHUB_REVIEW[qualifiers.review]}`)
  if (qualifiers.checks) parts.push(`status:${qualifiers.checks === 'passing' ? 'success' : 'failure'}`)
  const text = query.text.trim()
  if (text) parts.push(text)
  return parts.join(' ')
}

/**
 * Whether a row already on screen satisfies the typed qualifiers. `viewer` is
 * the login `author:me` resolves to for this row's host.
 *
 * `status:` is left out: whether checks pass is the host's answer alone, and a
 * row whose checks have not loaded yet must not vanish while it is asked.
 */
export function matchesPrQualifiers(
  pr: PullRequest,
  qualifiers: PrSearchQualifiers,
  viewer: string | null,
): boolean {
  const labels = pr.labels.map((label) => label.name.trim().toLowerCase())
  const holds = (name: string) => labels.includes(name.trim().toLowerCase())
  if (qualifiers.draft && pr.draft !== (qualifiers.draft === 'only')) return false
  if (qualifiers.review) {
    const status = qualifiers.review === 'none' ? 'no-reviews' : qualifiers.review
    if (pr.reviewStatus !== status) return false
  }
  if (qualifiers.labels && !qualifiers.labels.every((group) => group.some(holds))) return false
  if (qualifiers.excludedLabels?.some(holds)) return false
  if (qualifiers.author) {
    const wanted = qualifiers.author.toLowerCase() === 'me' ? viewer : qualifiers.author
    if (!wanted || pr.author.toLowerCase() !== wanted.toLowerCase()) return false
  }
  return true
}

/** Free text over the fields a row shows: number, title, repository, branch,
 *  author. What the page narrows by until the host has answered. */
export function matchesPrText(pr: PullRequest, text: string): boolean {
  const needle = text.trim().toLowerCase()
  if (needle.length === 0) return true
  return `#${pr.number} ${pr.title} ${pr.baseRepo.owner}/${pr.baseRepo.repo} ${pr.headRef} ${pr.author}`
    .toLowerCase()
    .includes(needle)
}

/**
 * How well a row answers the searched text, as a number to order by. Coarse on
 * purpose: "this is the one", "this mentions it", and "the host says so" —
 * GitHub also matches bodies and comments, which the row does not show.
 */
export function scorePrMatch(pr: PullRequest, text: string): number {
  const needle = text.trim().toLowerCase()
  if (needle.length === 0) return 0
  const number = needle.replace(/^#/u, '')
  if (/^\d+$/u.test(number)) return String(pr.number) === number ? 100 : 0

  const title = pr.title.toLowerCase()
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0)
  if (title === needle) return 90
  if (title.includes(needle)) return 80
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70
  if (pr.headRef.toLowerCase().includes(needle)) return 60
  if (pr.author.toLowerCase().includes(needle)) return 50
  if (`${pr.baseRepo.owner}/${pr.baseRepo.repo}`.toLowerCase().includes(needle)) return 40
  if (terms.some((term) => title.includes(term))) return 30
  return 10
}

/** Most convincing first, most recently updated among equals. */
export function rankPrMatches(prs: readonly PullRequest[], text: string): PullRequest[] {
  if (text.trim().length === 0) return [...prs]
  return prs.toSorted((left, right) =>
    scorePrMatch(right, text) - scorePrMatch(left, text) || right.updatedAt.localeCompare(left.updatedAt),
  )
}
