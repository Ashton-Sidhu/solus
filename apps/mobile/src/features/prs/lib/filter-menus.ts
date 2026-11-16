// Adapted from T3 Code features/pull-requests/PullRequestListFilters.tsx (MIT, see UPSTREAM.md).
import type { ControlPillMenuProps } from '../../../components/ControlPillMenu.types'
import {
  activePullRequestFilterCount,
  DEFAULT_PULL_REQUEST_LIST_PREFERENCES,
  type PullRequestListPreferences,
  type PullRequestListProject,
} from '../../workspace/list-preferences'
import {
  pullRequestListMenuChoice,
  type PullRequestListMenuField,
} from './list-filter-menu'

const STATES = { open: 'Open', closed: 'Closed', all: 'All states' } as const
const INVOLVEMENT = {
  all: 'All PRs',
  reviewing: 'Your review',
  authored: 'By you',
  others: 'Others',
} as const
const DRAFTS = {
  all: 'All drafts',
  only: 'Drafts only',
  hide: 'Hide drafts',
} as const
const REVIEWS = {
  all: 'All reviews',
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  none: 'No reviews',
} as const
const CHECKS = {
  all: 'All checks',
  passing: 'Passing',
  failing: 'Failing',
  pending: 'Running',
} as const
const SORTS = {
  updated: 'Recently updated',
  created: 'Newest created',
  oldest: 'Oldest updated',
} as const

const id = (field: PullRequestListMenuField, value: string) =>
  JSON.stringify([field, value])
function choices(
  field: PullRequestListMenuField,
  options: Readonly<{ [value: string]: string }>,
  selected: string,
): ControlPillMenuProps['actions'] {
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

const projectId = (project: PullRequestListProject | null) =>
  project ? JSON.stringify([project.hostId, project.projectPath]) : ''

/** The Filters menu: drafts, reviews, checks, project, sort, and reset. */
function moreFilterActions(
  value: PullRequestListPreferences,
  projects: readonly PullRequestFilterProject[],
  project: PullRequestListProject | null,
): ControlPillMenuProps['actions'] {
  const { draft, review, checks } = value.filters
  return [
    {
      id: 'drafts',
      title: draft ? DRAFTS[draft] : 'Drafts',
      subactions: choices('draft', DRAFTS, draft ?? 'all'),
    },
    {
      id: 'reviews',
      title: review ? REVIEWS[review] : 'Reviews',
      subactions: choices('review', REVIEWS, review ?? 'all'),
    },
    {
      id: 'checks',
      title: checks ? `${CHECKS[checks]} checks` : 'Checks',
      subactions: choices('checks', CHECKS, checks ?? 'all'),
    },
    {
      id: 'projects',
      title:
        projects.find(
          (candidate) => projectId(candidate) === projectId(project),
        )?.label ?? 'Project',
      subactions: choices(
        'project',
        Object.fromEntries([
          ['', 'All projects'],
          ...projects.map((candidate) => [
            projectId(candidate),
            candidate.label,
          ]),
        ]),
        projectId(project),
      ),
    },
    {
      id: 'sort',
      title: SORTS[value.sort],
      subactions: choices('sort', SORTS, value.sort),
    },
  ]
}

export interface PullRequestFilterProject extends PullRequestListProject {
  label: string
}

export interface PullRequestFilterMenuProps {
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
}

/** Both platforms use the same choices; Android also puts them in its header. */
export function pullRequestListFilterMenus(props: PullRequestFilterMenuProps) {
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
  const more = moreFilterActions(value, props.projects, props.project)
  const labels = [...new Set([...selectedLabels, ...props.labels])].slice(0, 60)
  const authors = [
    ...new Set([
      ...(author && author !== 'me' ? [author] : []),
      ...props.authors,
    ]),
  ].slice(0, 60)
  const hostActions = choices(
    'host',
    Object.fromEntries([
      ['', 'All hosts'],
      ...props.hosts.map((host) => [host.id, host.label]),
    ]),
    props.hostId ?? '',
  )
  const stateActions = choices('state', STATES, value.state)
  const involvementActions = choices(
    'involvement',
    INVOLVEMENT,
    value.involvement,
  )
  const labelActions: ControlPillMenuProps['actions'] = [
    { id: SEARCH_LABELS, title: 'Search labels…', image: 'magnifyingglass' },
    {
      id: id('labels', ''),
      title: 'All labels',
      state: selectedLabels.length ? 'off' : 'on',
    },
    ...labels.map((label) => ({
      id: id('label', label),
      title: label,
      state: selectedLabelSet.has(label) ? ('on' as const) : ('off' as const),
    })),
  ]
  const authorActions: ControlPillMenuProps['actions'] = [
    { id: SEARCH_AUTHORS, title: 'Search authors…', image: 'magnifyingglass' },
    ...choices(
      'author',
      Object.fromEntries([
        ['', 'All authors'],
        ['me', 'Me'],
        ...authors.map((login) => [login, login]),
      ]),
      author ?? '',
    ),
  ]
  const reset = (
    resetHost: boolean,
  ): ControlPillMenuProps['actions'][number] => ({
    id: id('reset', resetHost ? 'host' : ''),
    title: 'Reset filters',
    attributes: {
      disabled:
        count === 0 &&
        value.sort === DEFAULT_PULL_REQUEST_LIST_PREFERENCES.sort &&
        (!resetHost || props.hostId === null),
    },
  })
  const headerActions: ControlPillMenuProps['actions'] = [
    { id: 'hosts', title: 'Host', subactions: hostActions },
    { id: 'state', title: 'State', subactions: stateActions },
    { id: 'involvement', title: 'Involvement', subactions: involvementActions },
    { id: 'labels', title: 'Labels', subactions: labelActions },
    { id: 'author', title: 'Author', subactions: authorActions },
    ...more,
    reset(true),
  ]
  return {
    count,
    more: [...more, reset(false)],
    select,
    hostLabel:
      props.hosts.length > 1
        ? (props.hosts.find((host) => host.id === props.hostId)?.label ??
          'All hosts')
        : null,
    hostActions,
    stateLabel: STATES[value.state],
    stateActive: value.state !== 'open',
    stateActions,
    involvementLabel: INVOLVEMENT[value.involvement],
    involvementActive: value.involvement !== 'all',
    involvementActions,
    labelCount: selectedLabels.length,
    labelActions,
    author,
    authorActions,
    headerMenu: {
      actions: headerActions,
      onSelect: select,
      customized:
        count > 0 || value.sort !== 'updated' || props.hostId !== null,
    },
  }
}
