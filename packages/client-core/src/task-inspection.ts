import type {
  TaskExternalIssue,
  TaskInspection,
  TaskReactionContent,
  TaskTemplate
} from '@solus/contracts/task-inspection'
import type { TaskSource } from '@solus/contracts/task-sources'
import type { SolusAPI } from '@solus/contracts/host-api'

export interface TaskInspectionState {
  value: TaskInspection | null
  pending: boolean
  loadingMore: boolean
  error: string | null
}
type InspectionApi = Pick<SolusAPI, 'tasksInspect' | 'tasksReact'>

/** One issue's provider details. Failed reads retain rows; an old page cannot replace a refresh. */
export class TaskInspectionStore {
  #state: TaskInspectionState = { value: null, pending: false, loadingMore: false, error: null }
  #listeners = new Set<() => void>()
  #generation = 0
  #identity = 0
  #write: Promise<void> = Promise.resolve()
  #read: Promise<void> | null = null
  constructor(
    readonly taskId: string,
    private readonly api: () => InspectionApi
  ) {}
  get current(): TaskInspectionState {
    return this.#state
  }
  subscribe = (changed: () => void): (() => void) => {
    this.#listeners.add(changed)
    return () => {
      this.#listeners.delete(changed)
    }
  }
  #set(patch: Partial<TaskInspectionState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const changed of this.#listeners) changed()
  }
  reset(): void {
    this.#identity++
    this.#generation++
    this.#read = null
    this.#write = Promise.resolve()
    this.#set({ value: null, pending: false, loadingMore: false, error: null })
  }
  refresh(): Promise<void> {
    if (this.#read) return this.#read
    const generation = ++this.#generation
    this.#set({ pending: true, error: null })
    this.#read = Promise.resolve()
      .then(() => this.api().tasksInspect(this.taskId))
      .then(
        (value) => {
          if (generation === this.#generation) this.#set({ value })
        },
        (error: Error) => {
          if (generation === this.#generation) this.#set({ error: error.message })
        }
      )
      .finally(() => {
        if (generation === this.#generation) {
          this.#read = null
          this.#set({ pending: false })
        }
      })
    return this.#read
  }
  async loadMore(): Promise<void> {
    const before = this.#state.value
    if (!before?.historyCursor || this.#state.loadingMore || this.#state.pending) return
    const generation = this.#generation
    this.#set({ loadingMore: true, error: null })
    try {
      const page = await this.api().tasksInspect(this.taskId, before.historyCursor)
      if (generation !== this.#generation) return
      const events = new Map([...page.events, ...before.events].map((event) => [event.id, event]))
      const prs = new Map([...before.pullRequests, ...page.pullRequests].map((pr) => [pr.url, pr]))
      this.#set({
        value: {
          ...before,
          events: [...events.values()].sort((a, b) => a.at - b.at),
          historyCursor: page.historyCursor,
          pullRequests: [...prs.values()]
        }
      })
    } catch (error) {
      if (generation === this.#generation)
        this.#set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (generation === this.#generation) this.#set({ loadingMore: false })
    }
  }
  react(targetId: string, content: TaskReactionContent, add: boolean): Promise<void> {
    const identity = this.#identity
    const write = this.#write
      .catch(() => {})
      .then(async () => {
        if (identity !== this.#identity) throw new Error('The task account changed.')
        await this.api().tasksReact(this.taskId, targetId, content, add)
      // A read started before this write can carry the old reaction count.
      await this.#read
        if (identity === this.#identity) await this.refresh()
      })
    this.#write = write
    return write
  }
}

/** Composer choices are read only when a source is selected. */
export class TaskTemplateStore {
  #generation = 0
  pending = false
  templates: TaskTemplate[] = []
  error: string | null = null
  reset(): void {
    this.#generation++
    this.templates = []
    this.error = null
    this.pending = false
  }
  async load(api: Pick<SolusAPI, 'tasksTemplates'>, source: TaskSource): Promise<void> {
    const generation = ++this.#generation
    this.pending = true
    this.templates = []
    this.error = null
    try {
      const templates = await api.tasksTemplates(source)
      if (generation === this.#generation) this.templates = templates
    } catch (error) {
      if (generation === this.#generation)
        this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === this.#generation) this.pending = false
    }
  }
}

/** Read an external issue without adding a personal source. */
export class TaskUrlStore {
  value: TaskExternalIssue | null = null
  pending = false
  error: string | null = null
  #generation = 0
  async open(api: Pick<SolusAPI, 'tasksResolve'>, url: string): Promise<void> {
    const generation = ++this.#generation
    this.pending = true
    this.value = null
    this.error = null
    try {
      const result = await api.tasksResolve(url)
      if (generation === this.#generation) this.value = result
    } catch (error) {
      if (generation === this.#generation)
        this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === this.#generation) this.pending = false
    }
  }
  close(): void {
    this.#generation++
    this.value = null
    this.pending = false
    this.error = null
  }
}
