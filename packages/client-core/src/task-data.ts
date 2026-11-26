import type { SolusAPI } from '@solus/contracts/host-api'
import type { IssueComment, IssueDetails } from '@solus/contracts/task-types'
import type { IssueSource } from '@solus/contracts/task-sources'
import { providerDataFromMetadata, withTaskProviderMetadata } from '@solus/contracts/task-data'
import type {
  TaskProviderData,
  TaskProviderMetadata,
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
  details: TaskDataSection<IssueDetails>
  provider: TaskProviderState
}
type TaskDataApi = Pick<SolusAPI, 'issuesGet' | 'issuesReact'>

/** A copy from the task detail includes local attribution and delivery state. */
export function mergeTaskComments(details: readonly IssueComment[], timeline: readonly IssueComment[]): IssueComment[] {
  const comments = new Map(timeline.map((comment) => [comment.providerCommentId ?? comment.id, comment]))
  for (const comment of details) comments.set(comment.providerCommentId ?? comment.id, comment)
  return [...comments.values()]
}

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
  #detailsRead: Promise<IssueDetails> | null = null
  #providerRead: Promise<void> | null = null
  #write = Promise.resolve()
  constructor(
    readonly issueId: string,
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
  adopt(details: IssueDetails, provider?: TaskProviderData): void {
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
  /** `cached` reads the host's copy with no provider call. That copy holds no
   *  status options or provider metadata, so the ones from the last full read stay. */
  loadDetails(options: { refresh?: boolean; cached?: boolean } = {}): Promise<IssueDetails> {
    if (!options.refresh && this.#detailsRead) return this.#detailsRead
    const generation = ++this.#detailsGeneration
    this.#set({ details: { ...this.#state.details, pending: true, error: null } })
    const read = Promise.resolve()
      .then(() => options.cached
        ? this.api().issuesGet(this.issueId, { section: 'details', cached: true }).then((fresh) => withHeldProviderFacts(fresh, this.#state.details.value))
        : this.api().issuesGet(this.issueId))
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
  async #readProvider(cursor?: string, metadata?: TaskProviderMetadata): Promise<TaskProviderData> {
    const value = await this.api().issuesGet(this.issueId, {
      section: 'provider', cursor, ...(metadata && { timelineOnly: true as const })
    })
    if ('task' in value)
      throw new Error('Update the task host to read provider history and reactions.')
    return metadata ? withTaskProviderMetadata(value, metadata) : value
  }
  /** Metadata that carries history (the GitHub and Jira detail reads) is the section itself:
   *  the page shows it with no second read. */
  loadProvider(metadata?: TaskProviderMetadata): Promise<void> {
    if (metadata?.events) {
      this.#providerGeneration++
      this.#providerRead = null
      this.#provider({ value: providerDataFromMetadata(metadata), pending: false, error: null, loadingMore: false })
      return Promise.resolve()
    }
    if (this.#providerRead) return this.#providerRead
    const generation = ++this.#providerGeneration
    this.#provider({ pending: true, loadingMore: false, error: null })
    this.#providerRead = Promise.resolve()
      .then(() => this.#readProvider(undefined, metadata))
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
        [...page.pullRequests, ...before.value.pullRequests].map((pr) => [pr.url, pr])
      )
      const comments = before.value.comments || page.comments
        ? mergeTaskComments(before.value.comments ?? [], page.comments ?? [])
        : undefined
      this.#provider({
        value: {
          ...before.value,
          events: [...events.values()].sort((a, b) => a.at - b.at),
          ...(comments && { comments }),
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
        await this.api().issuesReact(this.issueId, targetId, content, add)
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
  async load(api: Pick<SolusAPI, 'issuesTemplates'>, source: IssueSource): Promise<void> {
    const generation = ++this.#generation
    this.pending = true
    this.templates = []
    this.error = null
    try {
      const templates = await api.issuesTemplates(source)
      if (generation === this.#generation) this.templates = templates
    } catch (error) {
      if (generation === this.#generation)
        this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === this.#generation) this.pending = false
    }
  }
}

/** A cached read keeps what only a provider read answers. */
function withHeldProviderFacts(fresh: IssueDetails, held: IssueDetails | null): IssueDetails {
  if (!held) return fresh
  return {
    ...fresh,
    ...(fresh.statusOptions === undefined && held.statusOptions && { statusOptions: held.statusOptions }),
    ...(fresh.providerMetadata === undefined && held.providerMetadata && { providerMetadata: held.providerMetadata }),
  }
}
