import type { Task } from '../../../contexts/tasks/task.svelte'
import type { TasksStore } from '../../../contexts/tasks/tasks.store.svelte'

const PROVIDER_SEARCH_DEBOUNCE_MS = 350

/**
 * The provider's answer to the text in the Tasks page's search box.
 *
 * A truncated source did not list every task, so filtering what is loaded
 * answers "of the tasks the host read" while looking like it answered "in the
 * project". The text then goes to the provider too. Debounced, because this is
 * a keystroke handler and the far end is a network search. The results are
 * the page's own: they are not part of the task list.
 */
export class ProviderTaskSearch {
  /** The tasks the provider found for `query`. */
  results = $state<Task[]>([])
  /** The search text that `results` answer. Empty = no search answered. */
  query = $state('')
  searching = $state(false)
  error = $state<string | null>(null)

  #timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by each request, so an older answer never replaces a newer one. */
  #generation = 0

  constructor(private readonly store: TasksStore) {}

  /** Ask the provider for a project's tasks that match, after a pause in typing. */
  request(serverId: string, cwd: string, query: string): void {
    const trimmed = query.trim()
    if (this.#timer) clearTimeout(this.#timer)
    if (!trimmed) {
      this.clear()
      return
    }
    // A text that the provider answered, or failed to answer, is not asked
    // again until it changes.
    if (trimmed === this.query) {
      // The text is back at the one already answered: drop a request in flight.
      this.#generation++
      this.searching = false
      return
    }
    const generation = ++this.#generation
    this.searching = true
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#search(serverId, cwd, trimmed, generation)
    }, PROVIDER_SEARCH_DEBOUNCE_MS)
  }

  async #search(serverId: string, cwd: string, query: string, generation: number): Promise<void> {
    let results: Task[] = []
    let failure: string | null = null
    try {
      results = await this.store.search(serverId, cwd, query)
    } catch (error) {
      // The listed matches stay on screen; the page says the provider did not answer.
      failure = error instanceof Error ? error.message : String(error)
    }
    if (generation !== this.#generation) return
    this.results = results
    this.query = query
    this.error = failure
    this.searching = false
  }

  /** Forget the search: the box is empty, or the page shows another project. */
  clear(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#generation++
    this.results = []
    this.query = ''
    this.error = null
    this.searching = false
  }
}
