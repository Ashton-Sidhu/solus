// A task picker lists the tasks its host already holds. A task source that
// holds more tasks than the host read is truncated, so a query also goes to
// the provider (`TasksStore.search`), and the picker shows what only the
// provider found (docs/plans/provider-owned-tasks.md §5).

const SEARCH_DEBOUNCE_MS = 250
/** A shorter query matches most of a source, and each search is a provider call. */
const MIN_QUERY_LENGTH = 2

export class ProviderTaskSearch<T extends { id: string }> {
  /** What the provider found for the newest query that it answered. */
  results = $state.raw<T[]>([])
  /** True from the moment a query is typed until its answer, or its failure. */
  searching = $state(false)
  /** Why the newest search failed, in the provider's words. */
  error = $state<string | null>(null)

  private timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by each request, so an older answer never replaces a newer one. */
  private generation = 0

  /** `search` asks the provider. A task belongs to no project, so every
   *  picker searches the person's task sources. */
  constructor(private readonly search: (query: string) => Promise<T[]>) {}

  /** Ask the provider once the person stops typing. An empty or short query
   *  clears the results. */
  request(query: string): void {
    this.cancel()
    const text = query.trim()
    if (text.length < MIN_QUERY_LENGTH) {
      this.results = []
      return
    }
    const generation = this.generation
    this.searching = true
    this.timer = setTimeout(() => {
      this.timer = null
      void this.ask(text, generation)
    }, SEARCH_DEBOUNCE_MS)
  }

  private async ask(text: string, generation: number): Promise<void> {
    try {
      const results = await this.search(text)
      if (generation !== this.generation) return
      this.results = results
    } catch (error) {
      if (generation !== this.generation) return
      this.results = []
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.searching = false
  }

  /** Drop a search that waits or is in flight: the picker closed, or the query changed. */
  cancel(): void {
    this.generation++
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.searching = false
    this.error = null
  }
}

/** The found tasks that the picker does not list already, so a task shows one time. */
export function tasksOnlyFound<T extends { id: string }>(found: readonly T[], listed: readonly { id: string }[]): T[] {
  const listedIds = new Set(listed.map((task) => task.id))
  return found.filter((task) => !listedIds.has(task.id))
}

