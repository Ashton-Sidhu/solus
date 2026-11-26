import type { TaskInvolvement } from '@solus/contracts/task-data'
import type { Issue } from '../../../contexts/tasks/task.svelte'
import type { IssuesStore } from '../../../contexts/tasks/tasks.store.svelte'

const PROVIDER_SEARCH_DEBOUNCE_MS = 350

/**
 * The provider's answer to the text in the Tasks page's search box.
 *
 * A truncated source did not list every task, so filtering what is loaded
 * answers "of the tasks the host read" while looking like it answered "in the
 * source". The text then goes to the provider too. Debounced, because this is
 * a keystroke handler and the far end is a network search. The results are
 * the page's own: they are not part of the task list.
 */
export class ProviderTaskSearch {
  /** The tasks the provider found for `query`. */
  results = $state<Issue[]>([])
  /** The search text that `results` answer. Empty = no search answered. */
  query = $state('')
  involvement = $state<TaskInvolvement>('all')
  searching = $state(false)
  error = $state<string | null>(null)

  #timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by each request, so an older answer never replaces a newer one. */
  #generation = 0
  #scope = ''

  constructor(private readonly store: IssuesStore) {}

  /** Ask the provider for the tasks of the person's sources that match, after a pause in typing. */
  request(query: string, involvement: TaskInvolvement = 'all', scope = ''): void {
    if (scope !== this.#scope) { this.clear(); this.#scope = scope }
    const trimmed = query.trim()
    if (this.#timer) clearTimeout(this.#timer)
    if (!trimmed && involvement === 'all') {
      this.clear()
      return
    }
    // A text that the provider answered, or failed to answer, is not asked
    // again until it changes.
    if (trimmed === this.query && involvement === this.involvement) {
      // The text is back at the one already answered: drop a request in flight.
      this.#generation++
      this.searching = false
      return
    }
    const generation = ++this.#generation
    this.searching = true
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#search(trimmed, generation, involvement)
    }, PROVIDER_SEARCH_DEBOUNCE_MS)
  }

  async #search(query: string, generation: number, involvement: TaskInvolvement): Promise<void> {
    let results: Issue[] = []
    let failure: string | null = null
    try {
      results = await this.store.search(query, involvement)
    } catch (error) {
      // The listed matches stay on screen; the page says the provider did not answer.
      failure = error instanceof Error ? error.message : String(error)
    }
    if (generation !== this.#generation) return
    this.results = results
    this.query = query
    this.involvement = involvement
    this.error = failure
    this.searching = false
  }

  /** Forget the search: the box is empty, or no source is truncated. */
  clear(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#generation++
    this.results = []
    this.query = ''
    this.involvement = 'all'
    this.error = null
    this.searching = false
  }
}
