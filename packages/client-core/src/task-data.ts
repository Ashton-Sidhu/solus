import type { SolusAPI } from '@solus/contracts/host-api'
import type { TaskDetails } from '@solus/contracts/task-types'
import type { TaskSource } from '@solus/contracts/task-sources'
import type {
  TaskExternalIssue,
  TaskProviderData,
  TaskReactionContent,
  TaskTemplate
} from '@solus/contracts/task-data'

export interface TaskDataSection<T> {
  value: T | null
  pending: boolean
  error: string | null
}
export interface TaskProviderState extends TaskDataSection<TaskProviderData> {
  loadingMore: boolean
}
export interface TaskDataState {
  details: TaskDataSection<TaskDetails>
  provider: TaskProviderState
}
type TaskDataApi = Pick<SolusAPI, 'tasksGet' | 'tasksReact'>

/** One task's reads. Each section has its own loading, failure and stale-response guard. */
export class TaskDataStore {
  #state: TaskDataState = {
    details: { value: null, pending: false, error: null },
    provider: { value: null, pending: false, error: null, loadingMore: false }
  }
  #listeners = new Set<() => void>()
  #identity = 0
  #detailsGeneration = 0
  #providerGeneration = 0
  #detailsRead: Promise<TaskDetails> | null = null
  #providerRead: Promise<void> | null = null
  #write = Promise.resolve()
  constructor(
    readonly taskId: string,
    private readonly api: () => TaskDataApi
  ) {}
  get current(): TaskDataState {
    return this.#state
  }
  subscribe = (changed: () => void): (() => void) => {
    this.#listeners.add(changed)
    return () => {
      this.#listeners.delete(changed)
    }
  }
  #set(patch: Partial<TaskDataState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const changed of this.#listeners) changed()
  }
  #provider(patch: Partial<TaskProviderState>): void {
    this.#set({ provider: { ...this.#state.provider, ...patch } })
  }
  reset(): void {
    this.#identity++
    this.#detailsGeneration++
    this.#providerGeneration++
    this.#detailsRead = null
    this.#providerRead = null
    this.#write = Promise.resolve()
    this.#set({
      details: { value: null, pending: false, error: null },
      provider: { value: null, pending: false, error: null, loadingMore: false }
    })
  }
  /** Adopt a successful write or URL read without another provider request. */
  adopt(details: TaskDetails, provider?: TaskProviderData): void {
    this.#detailsGeneration++
    this.#detailsRead = null
    const patch: Partial<TaskDataState> = {
      details: { value: details, pending: false, error: null }
    }
    if (provider) {
      this.#providerGeneration++
      this.#providerRead = null
      patch.provider = { value: provider, pending: false, error: null, loadingMore: false }
    }
    this.#set(patch)
  }
  loadDetails(options: { refresh?: boolean } = {}): Promise<TaskDetails> {
    if (!options.refresh && this.#detailsRead) return this.#detailsRead
    const generation = ++this.#detailsGeneration
    this.#set({ details: { ...this.#state.details, pending: true, error: null } })
    const read = Promise.resolve()
      .then(() => this.api().tasksGet(this.taskId))
      .then(
        (value) => {
          if (generation === this.#detailsGeneration)
            this.#set({ details: { value, pending: false, error: null } })
          return value
        },
        (error) => {
          if (generation === this.#detailsGeneration)
            this.#set({
              details: {
                ...this.#state.details,
                pending: false,
                error: error instanceof Error ? error.message : String(error)
              }
            })
          throw error
        }
      )
      .finally(() => {
        if (generation === this.#detailsGeneration) this.#detailsRead = null
      })
    this.#detailsRead = read
    return read
  }
  async #readProvider(cursor?: string): Promise<TaskProviderData> {
    const value = await this.api().tasksGet(this.taskId, { section: 'provider', cursor })
    if ('task' in value)
      throw new Error('Update the task host to read provider history and reactions.')
    return value
  }
  loadProvider(): Promise<void> {
    if (this.#providerRead) return this.#providerRead
    const generation = ++this.#providerGeneration
    this.#provider({ pending: true, loadingMore: false, error: null })
    this.#providerRead = Promise.resolve()
      .then(() => this.#readProvider())
      .then(
        (value) => {
          if (generation === this.#providerGeneration) this.#provider({ value })
        },
        (error) => {
          if (generation === this.#providerGeneration)
            this.#provider({ error: error instanceof Error ? error.message : String(error) })
        }
      )
      .finally(() => {
        if (generation === this.#providerGeneration) {
          this.#providerRead = null
          this.#provider({ pending: false })
        }
      })
    return this.#providerRead
  }
  async loadOlderHistory(): Promise<void> {
    const before = this.#state.provider
    if (!before.value?.historyCursor || before.pending || before.loadingMore) return
    const generation = this.#providerGeneration
    this.#provider({ loadingMore: true, error: null })
    try {
      const page = await this.#readProvider(before.value.historyCursor)
      if (generation !== this.#providerGeneration) return
      const events = new Map(
        [...page.events, ...before.value.events].map((event) => [event.id, event])
      )
      const pullRequests = new Map(
        [...before.value.pullRequests, ...page.pullRequests].map((pr) => [pr.url, pr])
      )
      this.#provider({
        value: {
          ...before.value,
          events: [...events.values()].sort((a, b) => a.at - b.at),
          historyCursor: page.historyCursor,
          pullRequests: [...pullRequests.values()]
        }
      })
    } catch (error) {
      if (generation === this.#providerGeneration)
        this.#provider({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (generation === this.#providerGeneration) this.#provider({ loadingMore: false })
    }
  }
  react(targetId: string, content: TaskReactionContent, add: boolean): Promise<void> {
    const identity = this.#identity
    const write = this.#write
      .catch(() => {})
      .then(async () => {
        if (identity !== this.#identity) throw new Error('The task account changed.')
        await this.api().tasksReact(this.taskId, targetId, content, add)
        await this.#providerRead
        if (identity === this.#identity) await this.loadProvider()
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
