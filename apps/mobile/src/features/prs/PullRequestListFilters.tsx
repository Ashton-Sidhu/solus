// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestListFilters.tsx (MIT, see UPSTREAM.md).
import { ScrollView } from 'react-native'
import type { ControlPillMenuProps } from '../../components/ControlPillMenu.types'
import { ListFilterMenu } from '../workspace/ListFilterMenu'
import {
  activePullRequestFilterCount,
  DEFAULT_PULL_REQUEST_LIST_PREFERENCES,
  type PullRequestListPreferences,
  type PullRequestListProject,
} from '../workspace/list-preferences'
import { pullRequestListMenuChoice, type PullRequestListMenuField } from './lib/list-filter-menu'

const STATES = { open: 'Open', closed: 'Closed', all: 'All states' } as const
const INVOLVEMENT = { all: 'All PRs', reviewing: 'Your review', authored: 'By you', others: 'Others' } as const
const DRAFTS = { all: 'All drafts', only: 'Drafts only', hide: 'Hide drafts' } as const
const REVIEWS = {
  all: 'All reviews',
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  none: 'No reviews',
} as const
const CHECKS = { all: 'All checks', passing: 'Passing', failing: 'Failing', pending: 'Running' } as const
const SORTS = { updated: 'Recently updated', created: 'Newest created', oldest: 'Oldest updated' } as const

const id = (field: PullRequestListMenuField, value: string) => JSON.stringify([field, value])
function choices(field: PullRequestListMenuField, options: Readonly<{ [value: string]: string }>, selected: string): ControlPillMenuProps['actions'] {
  return Object.entries(options).map(([value, title]) => ({
    id: id(field, value),
    title,
    state: value === selected ? ('on' as const) : ('off' as const),
  }))
}

/** Menu items that open the host search; not `[field, value]` ids, so the
 *  menu choice reducer never reads them. */
const SEARCH_LABELS = 'search-labels'
const SEARCH_AUTHORS = 'search-authors'

const projectId = (project: PullRequestListProject | null) => (project ? JSON.stringify([project.hostId, project.projectPath]) : '')

/** The Filters menu: drafts, reviews, checks, project, sort, and reset. */
function moreFilterActions(
  value: PullRequestListPreferences,
  projects: readonly PullRequestFilterProject[],
  project: PullRequestListProject | null,
  count: number,
): ControlPillMenuProps['actions'] {
  const { draft, review, checks } = value.filters
  return [
    { id: 'drafts', title: draft ? DRAFTS[draft] : 'Drafts', subactions: choices('draft', DRAFTS, draft ?? 'all') },
    { id: 'reviews', title: review ? REVIEWS[review] : 'Reviews', subactions: choices('review', REVIEWS, review ?? 'all') },
    { id: 'checks', title: checks ? `${CHECKS[checks]} checks` : 'Checks', subactions: choices('checks', CHECKS, checks ?? 'all') },
    {
      id: 'projects',
      title: projects.find((candidate) => projectId(candidate) === projectId(project))?.label ?? 'Project',
      subactions: choices('project', Object.fromEntries([['', 'All projects'], ...projects.map((candidate) => [projectId(candidate), candidate.label])]), projectId(project)),
    },
    { id: 'sort', title: SORTS[value.sort], subactions: choices('sort', SORTS, value.sort) },
    { id: id('reset', ''), title: 'Reset filters', attributes: { disabled: count === 0 && value.sort === DEFAULT_PULL_REQUEST_LIST_PREFERENCES.sort } },
  ]
}

export interface PullRequestFilterProject extends PullRequestListProject {
  label: string
}

/** The pill row above the list: a menu of further filters, then host, state,
 *  involvement, labels, and author. */
export function PullRequestListFilters(props: {
  readonly hosts: readonly { id: string; label: string }[]
  readonly hostId: string | null
  readonly project: PullRequestListProject | null
  readonly value: PullRequestListPreferences
  readonly onChange: (value: PullRequestListPreferences) => void
  readonly authors: readonly string[]
  readonly labels: readonly string[]
  readonly projects: readonly PullRequestFilterProject[]
  /** Opens the host search for labels or authors beyond the loaded rows. */
  readonly onSearch: (field: 'label' | 'author') => void
}) {
  const { value } = props
  const selectedLabels = value.filters.labels?.flat() ?? []
  const selectedLabelSet = new Set(selectedLabels)
  const author = value.filters.author
  const select = (event: string) => {
    if (event === SEARCH_LABELS || event === SEARCH_AUTHORS) {
      props.onSearch(event === SEARCH_LABELS ? 'label' : 'author')
      return
    }
    const next = pullRequestListMenuChoice(event, {
      value,
      hostIds: props.hosts.map((host) => host.id),
      projects: props.projects,
    })
    if (next) props.onChange(next)
  }
  const count = activePullRequestFilterCount(value)
  const more = moreFilterActions(value, props.projects, props.project, count)
  const labels = [...new Set([...selectedLabels, ...props.labels])].slice(0, 60)
  const authors = [...new Set([...(author && author !== 'me' ? [author] : []), ...props.authors])].slice(0, 60)
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 }}>
      <ListFilterMenu
        label={count ? String(count) : 'Filters'}
        icon
        active={count > 0}
        accessibilityLabel={count ? `Filters, ${count} active` : 'More filters'}
        actions={more}
        onSelect={select}
      />
      {props.hosts.length > 1 ? (
        <ListFilterMenu
          label={props.hosts.find((host) => host.id === props.hostId)?.label ?? 'All hosts'}
          active={props.hostId !== null}
          accessibilityLabel="Choose pull request host"
          actions={choices('host', Object.fromEntries([['', 'All hosts'], ...props.hosts.map((host) => [host.id, host.label])]), props.hostId ?? '')}
          onSelect={select}
        />
      ) : null}
      <ListFilterMenu
        label={STATES[value.state]}
        active={value.state !== 'open'}
        accessibilityLabel="Filter by state"
        actions={choices('state', STATES, value.state)}
        onSelect={select}
      />
      <ListFilterMenu
        label={INVOLVEMENT[value.involvement]}
        active={value.involvement !== 'all'}
        accessibilityLabel="Filter by involvement"
        actions={choices('involvement', INVOLVEMENT, value.involvement)}
        onSelect={select}
      />
      <ListFilterMenu
        label={selectedLabels.length ? `Labels ${selectedLabels.length}` : 'Labels'}
        active={selectedLabels.length > 0}
        accessibilityLabel="Filter by label"
        actions={[
          { id: SEARCH_LABELS, title: 'Search labels…' },
          { id: id('labels', ''), title: 'All labels', state: selectedLabels.length ? 'off' : 'on' },
          ...labels.map((label) => ({ id: id('label', label), title: label, state: selectedLabelSet.has(label) ? ('on' as const) : ('off' as const) })),
        ]}
        onSelect={select}
      />
      <ListFilterMenu
        label={author === 'me' ? 'By you' : (author ?? 'Author')}
        active={Boolean(author)}
        accessibilityLabel="Filter by author"
        actions={[
          { id: SEARCH_AUTHORS, title: 'Search authors…' },
          ...choices('author', Object.fromEntries([['', 'All authors'], ['me', 'Me'], ...authors.map((login) => [login, login])]), author ?? ''),
        ]}
        onSelect={select}
      />
    </ScrollView>
  )
}
