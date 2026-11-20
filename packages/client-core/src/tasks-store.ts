import type { SolusAPI } from '@solus/contracts/host-api'
import type { TaskSource } from '@solus/contracts/task-sources'
import type {
  Task,
  TaskCreateInput,
  TaskDetails,
  TaskMoveTarget,
  TaskSourceOptions,
  TaskSourceState,
  TaskSummary,
  TaskSessionLink,
  TaskUpdatePatch
} from '@solus/contracts/task-types'
import type { TaskExternalIssue, TaskInvolvement } from '@solus/contracts/task-inspection'
import { TaskInspectionStore, TaskTemplateStore } from './task-inspection'

export interface TasksState {
  tasks: TaskSummary[]
  sources: TaskSourceState[]
  options: TaskSourceOptions | null
  optionsPending: boolean
  loadingMore: boolean
  sessionsByTask: ReadonlyMap<string, TaskSessionLink[]>
  pending: boolean
  error: string | null
  details: ReadonlyMap<string, TaskDetails>
}
/** Transport-neutral task state for native clients. All reads name one host. */
export class TasksStore {
  #state: TasksState = {
    tasks: [],
    sources: [],
    options: null,
    optionsPending: false,
    loadingMore: false,
    sessionsByTask: new Map(),
    pending: false,
    error: null,
    details: new Map()
  }
  #listeners = new Set<() => void>()
  #optionsGeneration = 0
  #generation = 0
  #identity = 0
  #query = ''
  #involvement: TaskInvolvement = 'all'
  #inspections = new Map<string, TaskInspectionStore>()
  #detailsGeneration = new Map<string, number>()
  #pageRead: Promise<void> | null = null
  #writes = new Map<string, Promise<void>>()
  readonly templates = new TaskTemplateStore()
  constructor(
    private readonly api: () => SolusAPI,
    private readonly sources: () => TaskSource[]
  ) {}
  get current(): TasksState {
    return this.#state
  }
  subscribe = (changed: () => void): (() => void) => {
    this.#listeners.add(changed)
    return () => {
      this.#listeners.delete(changed)
    }
  }
  #set(patch: Partial<TasksState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const changed of this.#listeners) changed()
  }
  reset(): void {
    this.#query = ''
    this.#involvement = 'all'
    this.#identity++
    this.#optionsGeneration++
    this.#generation++
    this.#detailsGeneration.clear()
    this.#pageRead = null
    this.#writes.clear()
    for (const store of this.#inspections.values()) store.reset()
    this.templates.reset()
    this.#set({
      tasks: [],
      sources: [],
      options: null,
      optionsPending: false,
      loadingMore: false,
      sessionsByTask: new Map(),
      pending: false,
      error: null,
      details: new Map()
    })
  }
  async load(
    force = false,
    query = this.#query,
    involvement: TaskInvolvement = this.#involvement
  ): Promise<void> {
    this.#query = query
    this.#involvement = involvement
    const generation = ++this.#generation
    this.#set({ pending: true, error: null })
    try {
      const api = this.api(),
        configured = this.sources()
      const sources = await api.tasksSources(configured, force ? { refresh: 'force' } : undefined)
      if (generation !== this.#generation) return
      const [snapshot, snoozes] = await Promise.all([
        api.tasksSidebarSnapshot(),
        api.tasksSnoozes()
      ])
      if (generation !== this.#generation) return
      const searchSources =
        involvement === 'mentioned'
          ? configured.filter(
              (source) => source.kind === 'github-repo' || source.kind === 'github-project'
            )
          : configured
      const found =
        query.trim() || involvement !== 'all'
          ? await api.tasksSearch(searchSources, query, involvement)
          : snapshot.tasks
      const byTask = new Map(snoozes.map((snooze) => [snooze.taskId, snooze]))
      const tasks = found.map((task) => ({
        ...task,
        snoozedUntil: byTask.get(task.id)?.snoozedUntil,
        snoozeNote: byTask.get(task.id)?.snoozeNote
      }))
      if (generation !== this.#generation) return
      const keys = new Set(sources.map((source) => source.sourceKey))
      this.#set({
        sessionsByTask: new Map(Object.entries(snapshot.sessionsByTask)),
        sources,
        tasks: tasks.filter((task) => task.placements.some((place) => keys.has(place.sourceKey)))
      })
    } catch (error) {
      if (generation === this.#generation)
        this.#set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (generation === this.#generation) this.#set({ pending: false })
    }
  }
  async loadOptions(): Promise<void> {
    const identity = this.#identity
    const generation = ++this.#optionsGeneration
    this.#set({ optionsPending: true })
    try {
      const options = await this.api().tasksSourceOptions()
      if (identity === this.#identity && generation === this.#optionsGeneration)
        this.#set({ options, error: null })
    } catch (error) {
      if (identity === this.#identity && generation === this.#optionsGeneration)
        this.#set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (identity === this.#identity && generation === this.#optionsGeneration)
        this.#set({ optionsPending: false })
    }
  }
  async detail(taskId: string): Promise<TaskDetails> {
    const identity = this.#identity
    const generation = (this.#detailsGeneration.get(taskId) ?? 0) + 1
    this.#detailsGeneration.set(taskId, generation)
    const details = await this.api().tasksGet(taskId)
    if (identity === this.#identity && this.#detailsGeneration.get(taskId) === generation) {
      const next = new Map(this.#state.details)
      next.set(taskId, details)
      this.#set({ details: next })
    }
    return details
  }
  inspection(taskId: string): TaskInspectionStore {
    let store = this.#inspections.get(taskId)
    if (!store) {
      store = new TaskInspectionStore(taskId, this.api)
      this.#inspections.set(taskId, store)
    }
    return store
  }
  async #write(taskId: string, command: () => Promise<Task | TaskDetails | void>): Promise<void> {
    const identity = this.#identity
    const previous = this.#writes.get(taskId) ?? Promise.resolve()
    const write = previous
      .catch(() => {})
      .then(async () => {
        if (identity !== this.#identity) throw new Error('The task account changed.')
        await command()
        if (identity !== this.#identity) return
        await this.detail(taskId)
        if (identity === this.#identity) await this.load()
      })
    this.#writes.set(taskId, write)
    try {
      await write
    } finally {
      if (this.#writes.get(taskId) === write) this.#writes.delete(taskId)
    }
  }
  update(taskId: string, patch: TaskUpdatePatch): Promise<void> {
    return this.#write(taskId, () => this.api().tasksUpdate(taskId, patch))
  }
  move(taskId: string, target: TaskMoveTarget): Promise<void> {
    return this.#write(taskId, () => this.api().tasksMove(taskId, target))
  }
  comment(taskId: string, body: string): Promise<void> {
    return this.#write(taskId, () => this.api().tasksComment(taskId, body))
  }
  retryComment(taskId: string, commentId: string): Promise<void> {
    return this.#write(taskId, () => this.api().tasksRetryComment(taskId, commentId))
  }
  discardComment(taskId: string, commentId: string): Promise<void> {
    return this.#write(taskId, () => this.api().tasksDeleteComment(taskId, commentId))
  }
  snooze(taskId: string, until: number | null, note?: string): Promise<void> {
    return this.#write(taskId, async () => {
      await this.api().tasksSnooze(taskId, until, note)
    })
  }
  async create(input: TaskCreateInput): Promise<Task> {
    const identity = this.#identity
    const task = await this.api().tasksCreate(input)
    if (identity !== this.#identity) throw new Error('The task account changed.')
    await this.load()
    return task
  }
  loadMore(source: TaskSource): Promise<void> {
    if (this.#pageRead) return this.#pageRead
    const identity = this.#identity
    this.#set({ loadingMore: true, error: null })
    this.#pageRead = Promise.resolve()
      .then(async () => {
        if (identity !== this.#identity) return
        await this.api().tasksLoadMore(source)
        if (identity === this.#identity) await this.load()
      })
      .catch((error) => {
        if (identity === this.#identity)
          this.#set({ error: error instanceof Error ? error.message : String(error) })
        throw error
      })
      .finally(() => {
        if (identity === this.#identity) {
          this.#pageRead = null
          this.#set({ loadingMore: false })
        }
      })
    return this.#pageRead
  }

  async loadTemplates(source: TaskSource): Promise<void> {
    try {
      const read = this.templates.load(this.api(), source)
      this.#set({})
      await read
    } catch (error) {
      this.templates.error = error instanceof Error ? error.message : String(error)
    }
    this.#set({})
  }
  async resolve(url: string): Promise<TaskExternalIssue> {
    const identity = this.#identity
    const result = await this.api().tasksResolve(url)
    if (identity !== this.#identity) throw new Error('The task account changed.')
    const details = new Map(this.#state.details)
    details.set(result.details.task.id, result.details)
    this.#set({ details })
    return result
  }
}
