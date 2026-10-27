import type { HostApi } from './host-api'
import type { SessionRecordSearchQuery, SessionRecordSearchResult } from '@solus/contracts/types'

export interface SessionSearchHome { serverId: string; scope?: { projectRoot: string } | { repositoryKey: string } }
export interface HostSessionSearchHit { serverId: string; result: SessionRecordSearchResult }
export interface SessionSearchState {
  query: string
  hits: HostSessionSearchHit[]
  total: number
  remaining: number
  indexing: boolean
  loading: boolean
  loadingMore: boolean
  errors: Array<{ serverId: string; message: string }>
}
interface HostPage extends SessionSearchHome { next: number; total: number }
const empty = (): SessionSearchState => ({ query: '', hits: [], total: 0, remaining: 0, indexing: false, loading: false, loadingMore: false, errors: [] })
export const SESSION_SEARCH_PAGE_SIZE = 30

/** Paged search across homes. A slow or failed home never hides another home's reply. */
export class SessionSearch {
  state = empty()
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private pages: HostPage[] = []
  private options: Omit<SessionRecordSearchQuery, 'query' | 'offset' | 'limit'> = {}
  constructor(
    private readonly apiFor: (serverId: string) => Pick<HostApi, 'sessionRecordSearch'>,
    private readonly changed: () => void,
    private readonly debounceMs = 180,
  ) {}

  search(query: string, homes: readonly SessionSearchHome[], options: typeof this.options = {}): void {
    this.reset()
    const trimmed = query.trim().slice(0, 500)
    if (trimmed.length < 2) return
    this.options = options
    this.pages = homes.map(home => ({ ...home, next: 0, total: 0 }))
    this.state.query = trimmed
    this.state.loading = true
    this.changed()
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = null
      void Promise.all(this.pages.map(page => this.read(page, generation))).then(() => {
        if (generation !== this.generation) return
        this.state.loading = false
        this.changed()
      })
    }, this.debounceMs)
  }

  reset(): void {
    ++this.generation
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pages = []
    this.state = empty()
    this.changed()
  }

  async loadMore(): Promise<void> {
    if (this.state.loading || this.state.loadingMore || !this.state.remaining) return
    this.state.loadingMore = true
    this.changed()
    const generation = this.generation
    await Promise.all(this.pages.filter(page => page.next < page.total).map(page => this.read(page, generation)))
    if (generation !== this.generation) return
    this.state.loadingMore = false
    this.changed()
  }

  private async read(page: HostPage, generation: number): Promise<void> {
    const query = this.state.query
    try {
      const answer = await this.apiFor(page.serverId).sessionRecordSearch({ ...this.options, ...page.scope, query, offset: page.next, limit: SESSION_SEARCH_PAGE_SIZE })
      if (generation !== this.generation) return
      page.total = answer.total
      page.next = answer.results.length ? page.next + answer.results.length : page.total
      const seen = new Set(this.state.hits.map(hit => `${hit.serverId}\0${hit.result.record.sessionId}`))
      // Appending preserves every row already displayed, including keyboard selection.
      for (const result of answer.results) {
        const key = `${page.serverId}\0${result.record.sessionId}`
        if (!seen.has(key)) { seen.add(key); this.state.hits.push({ serverId: page.serverId, result }) }
      }
      this.state.indexing ||= answer.indexing
    } catch (error) {
      if (generation !== this.generation) return
      page.next = page.total
      this.state.errors.push({ serverId: page.serverId, message: error instanceof Error ? error.message : String(error) })
    }
    this.state.total = this.pages.reduce((sum, home) => sum + home.total, 0)
    this.state.remaining = this.pages.reduce((sum, home) => sum + Math.max(0, home.total - home.next), 0)
    this.changed()
  }
}
