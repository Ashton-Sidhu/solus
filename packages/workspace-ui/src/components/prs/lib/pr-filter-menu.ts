import { togglePrLabel } from '@solus/client-core/pr-label-filters'
import {
  ClipboardCheck as GuideIcon,
  CircleCheck as ChecksIcon,
  CircleDashed as PendingIcon,
  CircleSlash as NoReviewIcon,
  CircleX as FailureIcon,
  EyeOff as HideIcon,
  FilePenLine as DraftIcon,
  Layers as AllIcon,
  MessageSquareCheck as ReviewIcon,
  Aperture as ApertureIcon,
  Tag as TagIcon,
  User as UserIcon,
  Users as UsersIcon,
} from '@lucide/svelte'
import { GitPullRequestIcon, GitPullRequestDraftIcon as DraftOnlyIcon } from '../../ui/octicons'
import type { PrMenuQualifiers } from '@solus/client-core/pr-host-query'
import type { PrFilterChoice, PrFilterField, PullRequest } from '@solus/contracts/providers'
import type { ListIcon } from '../../ui/list-page'
import { labelChipColor } from '../../ui/labels/label-color'
import { OPEN_PR_STATUS_KEYS, PR_STATUS_OPTIONS, prStatusGlyph, type PrListView } from './prs-list-view'

export interface PrFilterOption {
  value: string
  label: string
  icon?: ListIcon
  avatarUrl?: string
  color?: string
  /** Text-colour classes for the icon, when the mark has a tone of its own. */
  toneClass?: string
  count?: number
}

/** One visible row and its radio submenu in the PR Filters menu. */
export interface PrFilterGroup {
  key: 'state' | 'involvement' | 'author' | 'labels' | 'excluded-labels' | 'draft' | 'review' | 'checks' | 'guide' | 'lens'
  label: string
  icon: ListIcon
  value: string
  valueLabel: string
  active: boolean
  multiple?: boolean
  selected?: string[]
  searchable?: boolean
  /** Asks the host for choices that match what is typed in the search field. */
  search?: (query: string) => void
  options: PrFilterOption[]
  select: (value: string) => void
}

/** Whether any choice of a menu carries a mark. A menu of words alone keeps
 *  no empty leading slot, so its labels start at the menu's edge. */
export function prFilterHasMarks(group: Pick<PrFilterGroup, 'key' | 'options'>): boolean {
  return group.options.some((option) => option.icon || option.color || option.avatarUrl || (group.key === 'author' && option.value === ''))
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

/** The menu choices the host can narrow by, as search qualifiers. The other
 *  facets (review, checks, guide, lens, involvement) narrow loaded rows. */
export function prMenuQualifiers(listView: Pick<PrListView, 'author' | 'label' | 'labelGroups' | 'labels' | 'excludedLabels' | 'draft'>): PrMenuQualifiers {
  return {
    labels: listView.labelGroups ?? (listView.labels ?? (listView.label ? [listView.label] : [])).map((label) => [label]),
    excludedLabels: listView.excludedLabels,
    author: listView.author,
    draft: listView.draft === 'draft' ? 'only' : listView.draft === 'ready' ? 'hide' : null,
  }
}

/** The choices only loaded rows can answer, as one key: a change starts the
 *  page fill (`BoundedPageFill`) again. */
export function prClientFilterKey(listView: PrListView): string {
  const { statusKeys, involvement, review, checks, guide, lens } = listView
  return JSON.stringify([statusKeys, involvement, review, checks, guide, lens])
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

/**
 * A picker's options: the loaded rows' choices with their counts first, then
 * what the host offers beyond them. A choice the rows already have is not
 * repeated.
 */
export function withHostChoices(
  loaded: readonly PrFilterOption[],
  host: readonly PrFilterChoice[],
  field: PrFilterField,
): PrFilterOption[] {
  const known = new Set(loaded.map((option) => option.value.toLowerCase()))
  const added = host
    .filter((choice) => !known.has(choice.value.toLowerCase()))
    .map((choice): PrFilterOption => field === 'label'
      ? { value: choice.value, label: choice.value, color: labelChipColor(choice.color ?? '') }
      : { value: choice.value, label: choice.value, avatarUrl: choice.avatarUrl })
  return [...loaded, ...added]
}

const INVOLVEMENT_LABELS = {
  all: 'All',
  created: 'Authored by me',
  others: 'Others',
  assigned: 'Assigned to me',
  'review-requested': 'Review requested',
} satisfies Record<PrListView['involvement'], string>

/**
 * Every row of the Filters menu. State and Involvement lead, because they are
 * also the crumbs the header folds into once the list scrolls.
 */
export function prFilterGroups(
  listView: PrListView,
  options: {
    authors: PrFilterOption[]
    labels: PrFilterOption[]
    search: (field: PrFilterField, query: string) => void
  },
  onStatusChange: (statusKeys: string[]) => void,
): PrFilterGroup[] {
  const stateValue = prStateValue(listView.statusKeys)
  return [
    {
      key: 'state', label: 'State', icon: GitPullRequestIcon,
      value: stateValue, valueLabel: stateValue === 'all' ? 'All' : `${stateValue[0].toUpperCase()}${stateValue.slice(1)}`,
      active: stateValue !== 'open',
      options: [
        ...(['open', 'merged', 'closed'] as const).map((status): PrFilterOption => {
          const glyph = prStatusGlyph(status)
          return { value: status, label: glyph.label, icon: glyph.icon, toneClass: glyph.toneClass }
        }),
        { value: 'all', label: 'All', icon: AllIcon },
      ],
      select: (value) => onStatusChange(prStatusKeysFor(value)),
    },
    {
      key: 'involvement', label: 'Involvement', icon: UsersIcon,
      value: listView.involvement,
      valueLabel: INVOLVEMENT_LABELS[listView.involvement],
      active: listView.involvement !== 'all',
      options: [
        { value: 'all', label: 'All' }, { value: 'created', label: 'Authored by me' },
        { value: 'assigned', label: 'Assigned to me' }, { value: 'review-requested', label: 'Review requested' }, { value: 'others', label: 'Others' },
      ],
      select: (value) => {
        if (value === 'all' || value === 'created' || value === 'assigned' || value === 'review-requested' || value === 'others') {
          listView.involvement = value
        }
      },
    },
    {
      key: 'author', label: 'Author', icon: UserIcon,
      value: listView.author ?? '', valueLabel: listView.author ?? 'Anyone',
      active: listView.author !== null, searchable: true, options: options.authors,
      search: (query) => options.search('author', query),
      select: (value) => (listView.author = value || null),
    },
    ...(['labels', 'excluded-labels'] as const).map((key): PrFilterGroup => {
      const selected = key === 'labels' ? listView.labelGroups?.flat() ?? listView.labels ?? (listView.label ? [listView.label] : []) : listView.excludedLabels ?? []
      return { key, label: key === 'labels' ? 'Include labels' : 'Exclude labels', icon: TagIcon,
        value: '', valueLabel: selected.length ? `${selected.length} selected` : 'Any', active: selected.length > 0,
        multiple: true, selected, searchable: true, options: [...options.labels, ...selected.filter((label) => !options.labels.some((option) => option.value.toLowerCase() === label.toLowerCase())).map((label) => ({ value: label, label, color: labelChipColor('') }))], search: (query) => options.search('label', query),
        select: (value) => {
          const next = !value ? [] : selected.includes(value) ? selected.filter((label) => label !== value) : [...selected, value]
          if (key === 'labels') {
            const groups = listView.labelGroups ?? (listView.labels ?? (listView.label ? [listView.label] : [])).map((label) => [label])
            listView.label = null; listView.labelGroups = value ? togglePrLabel(groups, value) : []; listView.labels = listView.labelGroups.flat()
          }
          else listView.excludedLabels = next
        },
      }
    }),
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
      key: 'guide', label: 'Review guide', icon: GuideIcon,
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

/** Every Filters-menu facet back to what the list opens on: open work, anyone's. The search stays. */
export function clearPrFilters(listView: PrListView): void {
  listView.involvement = 'all'
  listView.author = null
  listView.label = null
  listView.labelGroups = undefined
  listView.labels = []
  listView.excludedLabels = []
  listView.draft = 'all'
  listView.review = 'all'
  listView.checks = 'all'
  listView.guide = 'all'
  listView.lens = 'all'
  listView.statusKeys = prStatusKeysFor('open')
}
