/**
 * The pull request search a code host is asked, in GitHub's own syntax.
 *
 * Two inputs reach it: the qualifiers typed in a list's search field, and the
 * choices made in the list's filter menus. Both go to the host, so a filter
 * narrows every page the host reads, not only the rows a client has loaded.
 * Shared by the workspace UI and the mobile app.
 */

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

/** What a list's filter menus chose, in the qualifiers' terms. */
export interface PrMenuQualifiers {
  labels?: string[][]
  excludedLabels?: string[]
  author?: string | null
  draft?: 'only' | 'hide' | null
}

const GITHUB_REVIEW = {
  approved: 'approved',
  'changes-requested': 'changes_requested',
  'review-required': 'required',
  none: 'none',
} satisfies { [review in PrSearchReview]: string }

function quoted(name: string): string {
  return `"${name.replaceAll('"', '')}"`
}

/**
 * The query with the menu choices added. Labels add up, because every label
 * group must hold. The host takes one author and one draft state, so one
 * typed in the field wins over the menu's; the rows on screen are still
 * narrowed by both.
 */
export function withMenuQualifiers(query: PrSearchQuery, menu: PrMenuQualifiers): PrSearchQuery {
  const typed = query.qualifiers
  const qualifiers: PrSearchQualifiers = { ...typed }
  const labels = [...(typed.labels ?? []), ...(menu.labels ?? [])]
  const excludedLabels = [...(typed.excludedLabels ?? []), ...(menu.excludedLabels ?? [])]
  if (labels.length > 0) qualifiers.labels = labels
  if (excludedLabels.length > 0) qualifiers.excludedLabels = excludedLabels
  if (!typed.author && menu.author) qualifiers.author = menu.author
  if (!typed.draft && menu.draft) qualifiers.draft = menu.draft
  return { text: query.text, qualifiers }
}

/**
 * The query the code host is asked. Empty when there is nothing to narrow by,
 * which is the signal to read the ordinary listing instead. `author:me`
 * becomes GitHub's `author:@me`, so the host resolves who "me" is.
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
