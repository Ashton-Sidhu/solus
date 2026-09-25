import {
  BookOpenText as BookOpenTextIcon,
  CircleCheck as ChecksIcon,
  CircleDashed as PendingIcon,
  CircleSlash as NoReviewIcon,
  CircleX as FailureIcon,
  EyeOff as HideIcon,
  FilePenLine as DraftIcon,
  GitPullRequest as GitPullRequestIcon,
  GitPullRequestDraft as DraftOnlyIcon,
  Layers as AllIcon,
  MessageSquareCheck as ReviewIcon,
  Aperture as ApertureIcon,
  Tag as TagIcon,
  User as UserIcon,
  Users as UsersIcon,
} from '@lucide/svelte'
import type { PullRequest } from '@solus/contracts/providers'
import type { ListIcon } from '../../ui/list-page'
import { labelChipColor } from '../../ui/labels/label-color'
import { OPEN_PR_STATUS_KEYS, PR_STATUS_OPTIONS, type PrListView } from './prs-list-view'

export interface PrFilterOption {
  value: string
  label: string
  icon?: ListIcon
  avatarUrl?: string
  color?: string
  count?: number
}

/** One visible row and its radio submenu in the PR Filters menu. */
export interface PrFilterGroup {
  key: 'state' | 'involvement' | 'author' | 'labels' | 'draft' | 'review' | 'checks' | 'guide' | 'lens'
  label: string
  icon: ListIcon
  value: string
  valueLabel: string
  active: boolean
  searchable?: boolean
  options: PrFilterOption[]
  select: (value: string) => void
}

/** The state crumb's value: the open queue, one landed state, or everything. */
export function prStateValue(statusKeys: readonly string[]): string {
  if (statusKeys.length === PR_STATUS_OPTIONS.length) return 'all'
  if (statusKeys.includes('open')) return 'open'
  return statusKeys[0] ?? 'all'
}

/** The status keys a state crumb value stands for. Open keeps drafts. */
export function prStatusKeysFor(state: string): string[] {
  if (state === 'open') return [...OPEN_PR_STATUS_KEYS]
  if (state === 'all') return PR_STATUS_OPTIONS.map((option) => option.value)
  return [state]
}

/** Authors on the rows in view, most frequent first, behind an "Anyone" row. */
export function prAuthorOptions(prs: readonly PullRequest[]): PrFilterOption[] {
  const authors = new Map<string, { avatarUrl: string; count: number }>()
  for (const pr of prs) {
    const current = authors.get(pr.author)
    if (current) current.count += 1
    else if (pr.author) authors.set(pr.author, { avatarUrl: pr.authorAvatarUrl, count: 1 })
  }
  return [
    { value: '', label: 'Anyone', count: prs.length },
    ...Array.from(authors, ([author, facts]) => ({
      value: author,
      label: author,
      avatarUrl: facts.avatarUrl,
      count: facts.count,
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  ]
}

/** Labels on the rows in view, most frequent first, behind an "Any" row. */
export function prLabelOptions(prs: readonly PullRequest[]): PrFilterOption[] {
  const labels = new Map<string, { color: string; count: number }>()
  for (const pr of prs) {
    for (const label of pr.labels) {
      const current = labels.get(label.name)
      if (current) current.count += 1
      else labels.set(label.name, { color: labelChipColor(label.color), count: 1 })
    }
  }
  return [
    { value: '', label: 'Any', count: prs.length },
    ...Array.from(labels, ([label, facts]) => ({
      value: label,
      label,
      color: facts.color,
      count: facts.count,
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  ]
}

const INVOLVEMENT_LABELS = {
  all: 'All',
  created: 'Created',
  assigned: 'Assigned',
  'review-requested': 'Review requested',
} satisfies Record<PrListView['involvement'], string>

/**
 * Every row of the Filters menu. State and Involvement lead, because they are
 * also the crumbs the header folds into once the list scrolls.
 */
export function prFilterGroups(
  listView: PrListView,
  options: { authors: PrFilterOption[]; labels: PrFilterOption[] },
  onStatusChange: (statusKeys: string[]) => void,
): PrFilterGroup[] {
  const stateValue = prStateValue(listView.statusKeys)
  return [
    {
      key: 'state', label: 'State', icon: GitPullRequestIcon,
      value: stateValue, valueLabel: stateValue === 'all' ? 'All' : `${stateValue[0].toUpperCase()}${stateValue.slice(1)}`,
      active: stateValue !== 'open',
      options: [
        { value: 'open', label: 'Open' }, { value: 'merged', label: 'Merged' },
        { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' },
      ],
      select: (value) => onStatusChange(prStatusKeysFor(value)),
    },
    {
      key: 'involvement', label: 'Involvement', icon: UsersIcon,
      value: listView.involvement,
      valueLabel: INVOLVEMENT_LABELS[listView.involvement],
      active: listView.involvement !== 'all',
      options: [
        { value: 'all', label: 'All' }, { value: 'created', label: 'Created by you' },
        { value: 'assigned', label: 'Assigned to you' }, { value: 'review-requested', label: 'Review requested from you' },
      ],
      select: (value) => {
        if (value === 'all' || value === 'created' || value === 'assigned' || value === 'review-requested') {
          listView.involvement = value
        }
      },
    },
    {
      key: 'author', label: 'Author', icon: UserIcon,
      value: listView.author ?? '', valueLabel: listView.author ?? 'Anyone',
      active: listView.author !== null, searchable: true, options: options.authors,
      select: (value) => (listView.author = value || null),
    },
    {
      key: 'labels', label: 'Labels', icon: TagIcon,
      value: listView.label ?? '', valueLabel: listView.label ?? 'Any',
      active: listView.label !== null, options: options.labels,
      select: (value) => (listView.label = value || null),
    },
    {
      key: 'draft', label: 'Draft', icon: DraftIcon,
      value: listView.draft, valueLabel: ({ all: 'All', ready: 'Ready', draft: 'Draft' })[listView.draft],
      active: listView.draft !== 'all',
      options: [
        { value: 'all', label: 'All', icon: AllIcon },
        { value: 'draft', label: 'Drafts only', icon: DraftOnlyIcon },
        { value: 'ready', label: 'Hide drafts', icon: HideIcon },
      ],
      select: (value) => {
        if (value === 'all' || value === 'draft' || value === 'ready') listView.draft = value
      },
    },
    {
      key: 'review', label: 'Review', icon: ReviewIcon,
      value: listView.review,
      valueLabel: ({ all: 'All', approved: 'Approved', 'changes-requested': 'Changes requested', 'review-required': 'Review required', 'no-reviews': 'No reviews' })[listView.review],
      active: listView.review !== 'all',
      options: [
        { value: 'all', label: 'All', icon: AllIcon },
        { value: 'approved', label: 'Approved', icon: ChecksIcon },
        { value: 'changes-requested', label: 'Changes requested', icon: FailureIcon },
        { value: 'review-required', label: 'Review required', icon: PendingIcon },
        { value: 'no-reviews', label: 'No reviews', icon: NoReviewIcon },
      ],
      select: (value) => {
        if (value === 'all' || value === 'approved' || value === 'changes-requested' || value === 'review-required' || value === 'no-reviews') {
          listView.review = value
        }
      },
    },
    {
      key: 'checks', label: 'Checks', icon: ChecksIcon,
      value: listView.checks, valueLabel: ({ all: 'All', passing: 'Passing', pending: 'Running', failing: 'Failing' })[listView.checks],
      active: listView.checks !== 'all',
      options: [
        { value: 'all', label: 'All', icon: AllIcon },
        { value: 'passing', label: 'Passing', icon: ChecksIcon },
        { value: 'failing', label: 'Failing', icon: FailureIcon },
      ],
      select: (value) => {
        if (value === 'all' || value === 'passing' || value === 'pending' || value === 'failing') listView.checks = value
      },
    },
    {
      key: 'guide', label: 'Review guide', icon: BookOpenTextIcon,
      value: listView.guide ?? 'all', valueLabel: listView.guide === 'has-guide' ? 'Has guide' : 'All',
      active: listView.guide === 'has-guide',
      options: [{ value: 'all', label: 'All pull requests' }, { value: 'has-guide', label: 'Has review guide' }],
      select: (value) => { listView.guide = value === 'has-guide' ? 'has-guide' : 'all' },
    },
    {
      key: 'lens', label: 'Review lens', icon: ApertureIcon,
      value: listView.lens, valueLabel: listView.lens === 'has-lens' ? 'Has lens' : 'All',
      active: listView.lens === 'has-lens',
      options: [{ value: 'all', label: 'All pull requests' }, { value: 'has-lens', label: 'Has review lens' }],
      select: (value) => { listView.lens = value === 'has-lens' ? 'has-lens' : 'all' },
    },
  ]
}

/** Every filter back to what the list opens on: open work, anyone's, no search. */
export function clearPrFilters(listView: PrListView): void {
  listView.query = ''
  listView.involvement = 'all'
  listView.author = null
  listView.label = null
  listView.draft = 'all'
  listView.review = 'all'
  listView.checks = 'all'
  listView.guide = 'all'
  listView.lens = 'all'
  listView.statusKeys = prStatusKeysFor('open')
}
