// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestListFilters.tsx (MIT, see UPSTREAM.md).
import { z } from 'zod'
import {
  DEFAULT_PULL_REQUEST_LIST_PREFERENCES,
  pullRequestPreferencesForHost,
  type PullRequestListPreferences,
  type PullRequestListProject,
} from '../../workspace/list-preferences'

/**
 * What one choice in the Pull Requests tab's filter menus does. A menu item
 * id is `[field, value]` as JSON; an id that does not parse, or names a value
 * the menu does not offer, changes nothing.
 */

const FIELDS = ['host', 'reset', 'state', 'involvement', 'sort', 'project', 'label', 'labels', 'author', 'draft', 'review', 'checks'] as const
export type PullRequestListMenuField = (typeof FIELDS)[number]

const STATES = ['open', 'closed', 'all'] as const
const INVOLVEMENTS = ['all', 'authored', 'reviewing', 'others'] as const
const SORTS = ['updated', 'created', 'oldest'] as const
const DRAFTS = ['only', 'hide'] as const
const REVIEWS = ['approved', 'changes-requested', 'review-required', 'none'] as const
const CHECKS = ['pending', 'passing', 'failing'] as const
/** T3 stops at ten labels; the host's search has a limit too. */
const MAX_LABELS = 10

const MenuItemId = z.tuple([z.string(), z.string()])

interface MenuContext {
  value: PullRequestListPreferences
  hostIds: readonly string[]
  projects: readonly PullRequestListProject[]
}

type Filters = PullRequestListPreferences['filters']

function oneOf<const T extends string>(options: readonly T[], value: string): T | undefined {
  return options.find((option) => option === value)
}

/** The filters with one key set to `next`, or without it for "All". */
function withFilter<K extends 'draft' | 'review' | 'checks'>(
  value: PullRequestListPreferences,
  key: K,
  options: readonly NonNullable<Filters[K]>[],
  next: string,
): PullRequestListPreferences | null {
  const filters: Filters = { ...value.filters }
  delete filters[key]
  if (next === 'all') return { ...value, filters }
  const chosen = oneOf(options, next)
  if (!chosen) return null
  filters[key] = chosen
  return { ...value, filters }
}

function withLabels(value: PullRequestListPreferences, labels: readonly string[]): PullRequestListPreferences {
  const filters: Filters = { ...value.filters }
  delete filters.labels
  if (labels.length > 0) filters.labels = labels.map((label) => [label])
  return { ...value, filters }
}

type MenuChoice = (next: string, context: MenuContext) => PullRequestListPreferences | null

const CHOICES = {
  host: (next, { value, hostIds }) => {
    if (next === '') return { ...value, hostId: null }
    return hostIds.includes(next) ? pullRequestPreferencesForHost(value, next) : null
  },
  reset: (_next, { value }) => ({ ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, hostId: value.hostId }),
  state: (next, { value }) => {
    const state = oneOf(STATES, next)
    return state ? { ...value, state } : null
  },
  involvement: (next, { value }) => {
    const involvement = oneOf(INVOLVEMENTS, next)
    return involvement ? { ...value, involvement } : null
  },
  sort: (next, { value }) => {
    const sort = oneOf(SORTS, next)
    return sort ? { ...value, sort } : null
  },
  project: (next, { value, projects }) => {
    if (next === '') return { ...value, project: null }
    const project = projects.find((candidate) => JSON.stringify([candidate.hostId, candidate.projectPath]) === next)
    return project ? { ...value, project: { hostId: project.hostId, projectPath: project.projectPath } } : null
  },
  label: (next, { value }) => {
    const selected = value.filters.labels?.flat() ?? []
    return withLabels(value, selected.includes(next) ? selected.filter((label) => label !== next) : [...selected, next].slice(0, MAX_LABELS))
  },
  labels: (_next, { value }) => withLabels(value, []),
  author: (next, { value }) => {
    const filters: Filters = { ...value.filters }
    delete filters.author
    if (next) filters.author = next
    return { ...value, filters }
  },
  draft: (next, { value }) => withFilter(value, 'draft', DRAFTS, next),
  review: (next, { value }) => withFilter(value, 'review', REVIEWS, next),
  checks: (next, { value }) => withFilter(value, 'checks', CHECKS, next),
} satisfies { [Field in PullRequestListMenuField]: MenuChoice }

export function pullRequestListMenuChoice(event: string, context: MenuContext): PullRequestListPreferences | null {
  let selection: unknown
  try {
    selection = JSON.parse(event)
  } catch {
    return null
  }
  const parsed = MenuItemId.safeParse(selection)
  if (!parsed.success) return null
  const [field, next] = parsed.data
  const known = oneOf(FIELDS, field)
  return known ? CHOICES[known](next, context) : null
}
