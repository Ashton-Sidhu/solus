import type { ListedSession } from '../../../contexts/workspace/session-list.store.svelte'
import {
  DEFAULT_FILTER,
  applyFilter,
  applySessionFilter,
  bucketFor,
  buildSharedSessionItems,
  groupItems,
  groupSharedSessions,
  groupSharedWorks,
  isDefaultFilter,
  projectOptions,
  sortItems,
  sortSessionItems,
  splitByOwnership,
  workspaceTabs,
  type SortOrder,
  type TimeFilter,
  type TypeFilter,
  type WorkspaceFilter,
  type WorkspaceItem,
  type WorkspaceSessionItem,
  type WorkspaceTab,
} from './workspace-items'
import {
  appProjectOptions,
  appTimeCounts,
  applyAppFilter,
  groupAppItems,
  sortAppItems,
  type WorkspaceAppItem,
} from './workspace-apps'

const PINNED_PREVIEW = 6
const RENDER_PAGE = 80
const PINNED_COLLAPSED_KEY = 'solus.workspace.pinned-collapsed'

/** A tab's groups, cut to what is rendered: the ledger pages in 80 at a time
 *  and scrolling resolves the next batch rather than the whole history. */
export interface RenderedGroup<T> {
  key: string
  label: string
  total: number
  items: T[]
}

export function pageGroups<T>(groups: { key: string; label: string; items: T[] }[], budget: number): RenderedGroup<T>[] {
  const out: RenderedGroup<T>[] = []
  for (const group of groups) {
    if (budget <= 0) break
    const slice = group.items.slice(0, budget)
    budget -= slice.length
    out.push({ key: group.key, label: group.label, total: group.items.length, items: slice })
  }
  return out
}

export const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'oldest', label: 'Oldest' },
]

/**
 * What the Workspace page shows and where the reader is in it
 * (docs/workspace-page.md): the open tab, the filter, the sort, the keyboard
 * cursor, and everything derived from them. The page hands it the works,
 * the sessions, and the apps, and draws what it answers.
 */
export class WorkspaceLedger {
  /** Where the records come from: the works this window shows, the sessions
   *  in this person's list, and the apps of every connected host. Declared
   *  first: the derivations below read it, lazily, once something draws them. */
  private readonly source: {
    works: () => WorkspaceItem[]
    sessions: () => ListedSession[]
    apps: () => WorkspaceAppItem[]
  }

  tab = $state<WorkspaceTab>('yours')
  readonly filter = $state<WorkspaceFilter>({ ...DEFAULT_FILTER })
  sort = $state<SortOrder>('recent')
  selectedIndex = $state(0)
  renderLimit = $state(RENDER_PAGE)
  pinnedCollapsed = $state(localStorage.getItem(PINNED_COLLAPSED_KEY) === 'true')
  pinnedExpanded = $state(false)

  constructor(source: { works: () => WorkspaceItem[]; sessions: () => ListedSession[]; apps: () => WorkspaceAppItem[] }) {
    this.source = source
  }

  // ── The four groups ──
  readonly allItems = $derived.by(() => this.source.works())
  readonly ownership = $derived(splitByOwnership(this.allItems))
  readonly sharedSessionItems = $derived.by(() => buildSharedSessionItems(this.source.sessions()))
  readonly appItems = $derived.by(() => this.source.apps())
  readonly tabSpecs = $derived(
    workspaceTabs({
      yours: this.ownership.yours.length,
      'shared-works': this.ownership.shared.length,
      'shared-sessions': this.sharedSessionItems.length,
      apps: this.appItems.length,
    }),
  )
  /** The works the open tab holds; empty on the sessions tab and the apps tab. */
  readonly items = $derived(this.tab === 'yours' ? this.ownership.yours : this.tab === 'shared-works' ? this.ownership.shared : [])
  /** How many records the open tab holds before any filter. */
  readonly tabTotal = $derived(
    this.tab === 'shared-sessions' ? this.sharedSessionItems.length : this.tab === 'apps' ? this.appItems.length : this.items.length,
  )

  // ── Filtering ──
  readonly searching = $derived(!isDefaultFilter(this.filter))
  /** A card names its project unless the reader filtered to one, or the tab holds only one. */
  readonly showProject = $derived(!this.filter.project && new Set(this.items.map((item) => item.projectKey)).size > 1)
  readonly scopeLabel = $derived(
    (this.filter.project && (this.tab === 'apps' ? this.appItems : this.items).find((item) => item.projectKey === this.filter.project)?.projectLabel) || 'all projects',
  )
  readonly filtered = $derived(sortItems(applyFilter(this.items, this.filter), this.sort))
  readonly filteredSessions = $derived(sortSessionItems(applySessionFilter(this.sharedSessionItems, this.filter.text), this.sort))
  readonly filteredApps = $derived(sortAppItems(applyAppFilter(this.appItems, this.filter), this.sort))

  // ── Grouping ──
  /** The pinned group is the reader's own mark, so only their own tab has it;
   *  the shared works lead with what needs the reader instead. */
  readonly grouped = $derived(this.tab === 'yours' ? groupItems(this.filtered) : { pinned: [], groups: groupSharedWorks(this.filtered) })
  readonly sessionGroups = $derived(this.tab === 'shared-sessions' ? groupSharedSessions(this.filteredSessions) : [])
  readonly appGroups = $derived(this.tab === 'apps' ? groupAppItems(this.filteredApps) : [])
  readonly pinnedShown = $derived(
    this.pinnedCollapsed ? [] : this.pinnedExpanded ? this.grouped.pinned : this.grouped.pinned.slice(0, PINNED_PREVIEW),
  )
  readonly pinnedOverflow = $derived(this.pinnedCollapsed ? 0 : Math.max(0, this.grouped.pinned.length - PINNED_PREVIEW))
  readonly renderedGroups = $derived(pageGroups<WorkspaceItem>(this.grouped.groups, this.renderLimit))
  readonly renderedSessionGroups = $derived(pageGroups<WorkspaceSessionItem>(this.sessionGroups, this.renderLimit))
  readonly renderedAppGroups = $derived(pageGroups<WorkspaceAppItem>(this.appGroups, this.renderLimit))

  // ── The keyboard walk: exactly the rendered cards, in visual order ──
  readonly flat = $derived([...this.pinnedShown, ...this.renderedGroups.flatMap((g) => g.items)])
  readonly flatSessions = $derived(this.renderedSessionGroups.flatMap((g) => g.items))
  readonly flatApps = $derived(this.renderedAppGroups.flatMap((g) => g.items))
  readonly walkLength = $derived(
    this.tab === 'shared-sessions' ? this.flatSessions.length : this.tab === 'apps' ? this.flatApps.length : this.flat.length,
  )
  readonly hasMoreRows = $derived(
    this.tab === 'shared-sessions'
      ? this.flatSessions.length < this.filteredSessions.length
      : this.tab === 'apps'
        ? this.flatApps.length < this.filteredApps.length
        : this.renderedGroups.reduce((n, g) => n + g.items.length, 0) < this.grouped.groups.reduce((n, g) => n + g.items.length, 0),
  )
  readonly selectedItem = $derived<WorkspaceItem | null>(this.tab === 'yours' || this.tab === 'shared-works' ? (this.flat[this.selectedIndex] ?? null) : null)
  readonly selectedSession = $derived<WorkspaceSessionItem | null>(this.tab === 'shared-sessions' ? (this.flatSessions[this.selectedIndex] ?? null) : null)
  readonly selectedApp = $derived<WorkspaceAppItem | null>(this.tab === 'apps' ? (this.flatApps[this.selectedIndex] ?? null) : null)

  // ── Facet counts: each axis counted with its own facet released, so the
  //    numbers stay live against the rest of the filter ──
  readonly typeCounts = $derived.by(() => {
    const base = applyFilter(this.items, { ...this.filter, type: 'all' })
    const c = { all: base.length, doc: 0, artifact: 0 }
    for (const item of base) c[item.type]++
    return c
  })
  readonly timeCounts = $derived.by(() => {
    if (this.tab === 'apps') return appTimeCounts(applyAppFilter(this.appItems, { ...this.filter, time: 'all' }))
    const base = applyFilter(this.items, { ...this.filter, time: 'all' })
    const c = { today: 0, yesterday: 0, week: 0, older: 0 }
    const now = new Date()
    for (const item of base) {
      const key = bucketFor(item.timestamp, now).key
      if (key === 'today' || key === 'yesterday' || key === 'week') c[key]++
      else c.older++
    }
    return c
  })
  readonly projectOptions = $derived.by(() => {
    if (this.tab === 'apps') {
      const apps = applyAppFilter(this.appItems, { ...this.filter, project: '' })
      return [{ value: '', label: 'All projects', count: apps.length }, ...appProjectOptions(apps)]
    }
    const works = applyFilter(this.items, { ...this.filter, project: '' })
    return [{ value: '', label: 'All projects', count: works.length }, ...projectOptions(works)]
  })
  readonly pinnedCount = $derived(applyFilter(this.items, { ...this.filter, pinnedOnly: false }).filter((i) => i.pinned).length)
  readonly awaitingMyReviewCount = $derived(applyFilter(this.items, { ...this.filter, awaitingMyReview: false }).filter((i) => i.awaitingMyReview).length)
  /** Matches that exist outside the active facets (same text, no facets). */
  readonly outsideCount = $derived(applyFilter(this.items, { ...DEFAULT_FILTER, text: this.filter.text }).length)
  /** Type and Time partition the whole set, so each is one menu carrying its
   *  own live counts — the same filter state the `type:` / `time:` tokens write. */
  readonly typeOptions = $derived<{ value: TypeFilter; label: string; count: number }[]>([
    { value: 'all', label: 'Everything', count: this.typeCounts.all },
    { value: 'doc', label: 'Docs', count: this.typeCounts.doc },
    { value: 'artifact', label: 'Artifacts', count: this.typeCounts.artifact },
  ])
  readonly timeOptions = $derived<{ value: TimeFilter; label: string; count?: number }[]>([
    { value: 'all', label: 'Any time' },
    { value: 'today', label: 'Today', count: this.timeCounts.today },
    { value: 'yesterday', label: 'Yesterday', count: this.timeCounts.yesterday },
    { value: 'week', label: 'This week', count: this.timeCounts.week },
    { value: 'older', label: 'Older', count: this.timeCounts.older },
  ])
  /** An app has a project and a time; the type, pin, and review facets cut works only. */
  readonly activeFacetCount = $derived(
    Number(this.filter.time !== 'all') + Number(!!this.filter.project)
      + (this.tab === 'apps' ? 0 : Number(this.filter.type !== 'all') + Number(this.filter.pinnedOnly) + Number(this.filter.awaitingMyReview)),
  )

  // ── Commands ──
  togglePinnedCollapsed(): void {
    this.pinnedCollapsed = !this.pinnedCollapsed
    localStorage.setItem(PINNED_COLLAPSED_KEY, String(this.pinnedCollapsed))
  }

  clearFacets(): void {
    this.filter.type = 'all'
    this.filter.pinnedOnly = false
    this.filter.awaitingMyReview = false
    this.filter.time = 'all'
    this.filter.project = ''
  }

  clearFilters(): void {
    this.clearFacets()
    this.filter.text = ''
  }

  resetSelection(): void {
    this.selectedIndex = 0
    this.renderLimit = RENDER_PAGE
    this.pinnedExpanded = false
  }

  selectNext(): void {
    this.selectedIndex = Math.min(this.selectedIndex + 1, this.walkLength - 1)
  }

  selectPrevious(): void {
    this.selectedIndex = Math.max(this.selectedIndex - 1, 0)
  }

  /** The ledger is near its end: render the next page, when there is one. */
  renderMore(): void {
    const total = this.tab === 'shared-sessions'
      ? this.filteredSessions.length
      : this.tab === 'apps'
        ? this.filteredApps.length
        : this.grouped.groups.reduce((n, g) => n + g.items.length, 0)
    if (this.renderLimit < total) this.renderLimit += RENDER_PAGE
  }

  /** Where a group's first card sits in the keyboard walk. */
  offsetOf(group: RenderedGroup<WorkspaceItem>): number {
    return this.pinnedShown.length + this.renderedGroups.slice(0, this.renderedGroups.indexOf(group)).reduce((n, g) => n + g.items.length, 0)
  }

  sessionOffsetOf(group: RenderedGroup<WorkspaceSessionItem>): number {
    return this.renderedSessionGroups.slice(0, this.renderedSessionGroups.indexOf(group)).reduce((n, g) => n + g.items.length, 0)
  }

  appOffsetOf(group: RenderedGroup<WorkspaceAppItem>): number {
    return this.renderedAppGroups.slice(0, this.renderedAppGroups.indexOf(group)).reduce((n, g) => n + g.items.length, 0)
  }
}
