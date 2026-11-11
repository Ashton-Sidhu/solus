import type { TaskSourceState } from '@solus/contracts/task-types'
import type { Task } from '../../contexts/tasks/task.svelte'
import type { ListGroupSpec, ListRowPlace, ListStatusOption } from '../ui/list-page/list-page'
import {
  DEFAULT_TASK_SORT,
  NO_COLUMN_ID,
  boardColumnIdOf,
  buildBoard,
  moveTargetFor,
  sortTasks,
  type BoardColumn,
  type BoardView,
  type TaskSort,
} from './lib/tasks-api'
import { isTaskSnoozed, openColumnIds, taskGroups } from './lib/tasks-list-view'
import {
  matchesTaskQuery,
  sourceNotices,
  sourcesSyncState,
  withProviderMatches,
  type SourceNotice,
  type SourcesSyncState,
} from './lib/tasks-page'
import type { ProviderTaskSearch } from './lib/provider-search.svelte'

/** What the Tasks page hands to its view: the tasks and sources of the scope
 *  on screen, and the facts only the page can read. */
interface TasksPageViewInput {
  /** The tasks of the project on screen, or of every project. */
  tasks: () => Task[]
  /** The task sources of the project on screen. Empty for every project. */
  sources: () => TaskSourceState[]
  now: () => number
  /** Sessions whose agent works on the task now, not every linked one. */
  runningSessionsFor: (taskId: string) => number
  /** The project a row names, when the page shows more than one. */
  projectLabelFor: (taskId: string) => string | null
  /** The host a row names, when the task is not read by this machine. */
  homeFor: (taskId: string) => string | null
  /** The page shows every project, so each row names its project. */
  showsEveryProject: () => boolean
  providerSearch: ProviderTaskSearch
}

/**
 * How a person looks at the Tasks page: which source is on screen, the search
 * text, the filters, the sort, and the rows and columns that follow from them.
 *
 * One grouped list, re-plotted as a board. A source view shows the provider's
 * own columns; every source together is grouped by status category, because
 * columns of two sources do not line up (docs/plans/provider-owned-tasks.md
 * §7). The list and the board read the same columns, so a task can never be in
 * one layout and not the other.
 */
export class TasksPageView {
  layout = $state<'list' | 'board'>('list')
  query = $state('')
  sort = $state<TaskSort>(DEFAULT_TASK_SORT)
  runningOnly = $state(false)
  overdueOnly = $state(false)
  assignedOnly = $state(false)
  /** A snoozed task is out of the list until it wakes; this shows only those. */
  snoozedOnly = $state(false)
  /**
   * Which columns the list shows. Null = the ones a list opens on: the columns
   * of work that is not done, so finished tasks stay out of the way until asked
   * for. The board is exempt — its columns *are* this filter, and a kanban
   * whose last column is always empty reads as broken.
   */
  selectedColumnIds = $state<string[] | null>(null)
  /** The source on screen. Null = all sources. */
  #sourceKey = $state<string | null>(null)

  readonly #input: TasksPageViewInput

  constructor(input: TasksPageViewInput) {
    this.#input = input
  }

  // --- The source on screen -----------------------------------------------

  readonly source: TaskSourceState | null = $derived.by(
    () => this.#input.sources().find((source) => source.sourceKey === this.#sourceKey) ?? null,
  )

  readonly board: BoardView = $derived(
    this.source ? { kind: 'source', source: this.source } : { kind: 'all' },
  )

  /** The sources whose tasks are on screen. */
  readonly sources: TaskSourceState[] = $derived.by(() => (this.source ? [this.source] : this.#input.sources()))
  /** A source that cannot be read, or one that holds more tasks than the host read. */
  readonly notices: SourceNotice[] = $derived(sourceNotices(this.sources))
  readonly truncated: boolean = $derived(this.sources.some((source) => source.truncated))
  readonly syncState: SourcesSyncState = $derived(sourcesSyncState(this.sources))

  /** Show one source, or all of them with null. The column filter and the
   *  selection belong to the columns of one view, so they do not survive. */
  showSource(sourceKey: string | null): void {
    this.#sourceKey = sourceKey
    this.selectedColumnIds = null
  }

  // --- Filtering ----------------------------------------------------------

  get boardLayout(): boolean {
    return this.layout === 'board'
  }

  isOverdue = (task: Pick<Task, 'dueDate' | 'category'>): boolean => {
    if (!task.dueDate || task.category === 'done') return false
    return Date.parse(`${task.dueDate}T23:59:59`) < this.#input.now()
  }

  /** The tasks that the search keeps. A source view shows the tasks that the
   *  source lists; the mixed view shows each task of the project one time. */
  readonly searched: Task[] = $derived.by(() => {
    const { providerSearch } = this.#input
    return withProviderMatches(
      this.#input.tasks().filter((task) => matchesTaskQuery(task, this.query)),
      providerSearch.query === this.query.trim() ? providerSearch.results : [],
    ).filter((task) => boardColumnIdOf(task, this.board) !== null)
  })

  /** The snoozed tasks, or every other task: the list shows one of the two. */
  readonly inView: Task[] = $derived.by(() =>
    this.searched.filter((task) => isTaskSnoozed(task, this.#input.now()) === this.snoozedOnly),
  )

  /** The columns of the view, with every task that the search and the snooze
   *  filter keep. The list's column filter and its counts read these. */
  readonly columns: BoardColumn<Task>[] = $derived(buildBoard(this.inView, this.board))
  readonly columnIds: string[] = $derived(this.selectedColumnIds ?? openColumnIds(this.columns))

  readonly visibleTasks: Task[] = $derived.by(() => {
    let rows = this.inView
    if (!this.boardLayout) {
      rows = rows.filter((task) => this.columnIds.includes(boardColumnIdOf(task, this.board) ?? NO_COLUMN_ID))
    }
    if (this.runningOnly) rows = rows.filter((task) => this.#input.runningSessionsFor(task.id) > 0)
    if (this.overdueOnly) rows = rows.filter(this.isOverdue)
    if (this.assignedOnly) rows = rows.filter((task) => !!task.assignee)
    return sortTasks(rows, this.sort)
  })

  /**
   * The board's manual order renumbers the column a card lands in, so it only
   * means anything when `visibleTasks` *is* the board. (The column filter is
   * exempt — the board already ignores it.)
   */
  readonly boardUnfiltered: boolean = $derived(
    !this.query.trim() && !this.runningOnly && !this.overdueOnly && !this.assignedOnly && !this.snoozedOnly,
  )

  /**
   * How many tasks each filter chip would show. Counts are over the
   * search-filtered set but ignore the *other* toggles, so a chip's count still
   * means "how many more this would show" once another chip is already on.
   */
  readonly filterCounts = $derived.by(() => ({
    running: this.inView.filter((task) => this.#input.runningSessionsFor(task.id) > 0).length,
    overdue: this.inView.filter(this.isOverdue).length,
    assigned: this.inView.filter((task) => !!task.assignee).length,
    snoozed: this.searched.filter((task) => isTaskSnoozed(task, this.#input.now())).length,
  }))

  /**
   * The column filter's options. Counts are over the searched set, not the
   * column-filtered one — the number beside a column has to say what picking it
   * would show, which is exactly the question a filter that is currently
   * hiding it needs to answer.
   */
  readonly columnOptions: ListStatusOption[] = $derived(
    this.columns.map((column) => ({ value: column.id, label: column.label, count: column.tasks.length })),
  )

  /** The columns of the view that a task can be moved to: the bulk bar offers these. */
  readonly moveOptions: BoardColumn<Task>[] = $derived(
    this.columns.filter((column) => moveTargetFor(this.board, column.id) !== null),
  )

  /**
   * What the section headers cannot say is that the answer behind these rows
   * is incomplete — that note stays on the narrowing row, beside the search it
   * explains.
   */
  readonly truncationNote: string | null = $derived.by(() => {
    if (!this.truncated) return null
    const { providerSearch } = this.#input
    if (providerSearch.searching) return 'searching the provider…'
    if (providerSearch.error) return 'the provider did not answer the search'
    if (providerSearch.query && providerSearch.query === this.query.trim()) return 'searched the provider'
    return 'not every task is loaded · search reaches the rest'
  })

  clearFilters(): void {
    this.query = ''
    this.clearMenuFilters()
  }

  /** Clears what the Filters badge counts. The search stays. */
  clearMenuFilters(): void {
    this.runningOnly = false
    this.overdueOnly = false
    this.assignedOnly = false
    this.snoozedOnly = false
    this.selectedColumnIds = null
  }

  // --- Rows ---------------------------------------------------------------

  /**
   * The list is a table: project and host take one column of their own. The
   * column is drawn only when some row has something to put in it, and then on
   * every row, so the cells stay on one x.
   */
  readonly #showPlaceColumn: boolean = $derived.by(
    () => this.#input.showsEveryProject() || this.visibleTasks.some((task) => this.#input.homeFor(task.id) !== null),
  )

  #placeFor = (taskId: string): ListRowPlace | undefined => {
    if (!this.#showPlaceColumn) return undefined
    return { project: this.#input.projectLabelFor(taskId), host: this.#input.homeFor(taskId) }
  }

  /** One section for each column of the view that has a row. */
  readonly groups: ListGroupSpec[] = $derived.by(() =>
    taskGroups(
      buildBoard(this.visibleTasks, this.board),
      this.#input.runningSessionsFor,
      this.#input.now(),
      this.#placeFor,
    ),
  )

  /** The selectable rows in render order, for Shift range-select, arrow
   *  navigation, and detail-panel stepping. */
  readonly flatVisibleIds: string[] = $derived(
    this.groups.flatMap((group) => group.rows).map((row) => row.key),
  )
}
