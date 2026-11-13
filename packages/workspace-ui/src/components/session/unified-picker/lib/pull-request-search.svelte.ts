import type { PrFilter, PrListPage } from '@solus/contracts/providers'
import type { FoundPullRequest } from './picker-records'

/** The code host's search is rate limited, so it is asked less often than the
 *  hosts' own session index. */
const DEBOUNCE_MS = 300
/** A shorter query lists the open pull requests instead of asking the code
 *  host for nearly every one it holds. */
const MIN_QUERY_LENGTH = 2

/** One project whose pull requests a connected host can read. */
export interface PullRequestSearchProject {
  serverId: string
  projectRoot: string
  label: string
  /** Ask the project's host a question (`ProjectPrs.query`). */
  query: (filter: PrFilter) => Promise<PrListPage>
}

/**
 * The search's read of pull requests (docs/plans/unified-search.md, "Search
 * types"). With an empty box it reads the first page of open pull requests of
 * each project. Under a query it asks the code host, which reads every state
 * and text this client does not hold.
 *
 * Each project is asked through the pull request context (`ProjectPrs.query`):
 * the rows reach the index every surface reads, and the list of the Pull
 * requests page, which holds one filter's rows, is not touched. The candidates
 * here live only while the search is open.
 */
export class PullRequestSearch {
  results = $state<FoundPullRequest[]>([])
  /** The query the results answer: empty for the open list, null before the
   *  first answer. A row the host found for the query in the box is kept even
   *  when its title does not hold the words. */
  answeredQuery = $state<string | null>(null)
  loading = $state(false)
  /** Why a host could not answer, so an empty list does not claim there is nothing. */
  error = $state<string | null>(null)
  private timer: ReturnType<typeof setTimeout> | null = null
  private requestId = 0
  /** What the last request asked, so a change that names the same thing asks nothing. */
  private askedKey: string | null = null

  constructor(private readonly debounceMs = DEBOUNCE_MS) {}

  /** Ask for what the box and the scope now name. */
  search(query: string, projects: readonly PullRequestSearchProject[]): void {
    const trimmed = query.trim()
    const hostQuery = trimmed.length < MIN_QUERY_LENGTH ? '' : trimmed
    const key = `${hostQuery}\n${projects.map((project) => `${project.serverId}\0${project.projectRoot}`).join('\n')}`
    if (key === this.askedKey) return
    this.askedKey = key
    const requestId = ++this.requestId
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!projects.length) {
      this.results = []
      this.answeredQuery = hostQuery
      this.loading = false
      this.error = null
      return
    }
    this.loading = true
    // The open list is read at once: it is what the search opens on.
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(requestId, hostQuery, projects)
    }, hostQuery ? this.debounceMs : 0)
  }

  /** Whether the code host found the results for the query in the box. */
  answers(query: string): boolean {
    const trimmed = query.trim()
    return trimmed.length >= MIN_QUERY_LENGTH && this.answeredQuery === trimmed
  }

  reset(): void {
    this.requestId += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.askedKey = null
    this.results = []
    this.answeredQuery = null
    this.loading = false
    this.error = null
  }

  private async run(requestId: number, hostQuery: string, projects: readonly PullRequestSearchProject[]): Promise<void> {
    const filter: PrFilter = hostQuery ? { state: 'all', query: hostQuery } : { state: 'open' }
    const perProject = await Promise.all(projects.map(async (project): Promise<{ found: FoundPullRequest[]; error?: string }> => {
      try {
        const page = await project.query(filter)
        return {
          found: page.items.map((pullRequest) => ({ pullRequest, serverId: project.serverId, projectRoot: project.projectRoot, projectLabel: project.label })),
        }
      } catch (error) {
        // A project that cannot answer contributes nothing; the others still do.
        return { found: [], error: error instanceof Error ? error.message : String(error) }
      }
    }))
    if (requestId !== this.requestId) return
    this.results = perProject.flatMap((project) => project.found)
    this.answeredQuery = hostQuery
    this.error = perProject.find((project) => project.error)?.error ?? null
    this.loading = false
  }
}
