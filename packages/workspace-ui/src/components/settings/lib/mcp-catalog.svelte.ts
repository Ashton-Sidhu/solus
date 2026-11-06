import type { CatalogCategoryId, CatalogEntry } from '@solus/contracts/integration-types'
import { integrationsStore } from '../integrations.store.svelte'
import { McpInstalls } from './mcp-installs.svelte'

export const CATALOG_PAGE_SIZE = 24
const SEARCH_DELAY_MS = 250

/**
 * The catalog of one MCP page on one host: search, a category, a list that
 * grows as the person scrolls, and Add (`McpInstalls`). The sign-in
 * that follows is the connect dialog's. Ephemeral: it lives as long as the page.
 */
export class McpCatalog extends McpInstalls {
  query = $state('')
  /** One Solus category, or null for every entry. */
  category = $state<CatalogCategoryId | null>(null)
  entries = $state<CatalogEntry[]>([])
  total = $state(0)
  /** The first page of a query is loading. */
  loading = $state(true)
  /** More entries are loading below the ones shown. */
  loadingMore = $state(false)
  error = $state('')
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(serverId: string, query = '') {
    super(serverId)
    this.query = query
    void this.load()
  }

  get hasMore(): boolean {
    return this.entries.length < this.total
  }

  /** A new query starts the list again, after a short pause in typing. */
  setQuery(value: string): void {
    if (value === this.query) return
    this.query = value
    this.loading = true
    this.sequence++
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.load(), value.trim() ? SEARCH_DELAY_MS : 0)
  }

  /** A new category starts the list again at once. */
  setCategory(value: CatalogCategoryId | null): void {
    if (value === this.category) return
    this.category = value
    void this.load()
  }

  /** Reads the first page of the query. */
  async load(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    const sequence = ++this.sequence
    this.loading = true
    this.loadingMore = false
    this.error = ''
    try {
      const page = await integrationsStore.catalogPage(this.serverId, this.query.trim(), this.category, 0, CATALOG_PAGE_SIZE)
      if (sequence !== this.sequence) return
      this.entries = page.entries
      this.total = page.total
    } catch {
      if (sequence !== this.sequence) return
      this.entries = []
      this.total = 0
      this.error = 'The catalog is not available now. You can still add a server by its address.'
    }
    this.loading = false
  }

  /** Adds the next page below the entries shown; nothing above them moves. */
  async loadMore(): Promise<void> {
    if (this.loading || this.loadingMore || !this.hasMore) return
    const sequence = this.sequence
    this.loadingMore = true
    try {
      const page = await integrationsStore.catalogPage(this.serverId, this.query.trim(), this.category, this.entries.length, CATALOG_PAGE_SIZE)
      if (sequence !== this.sequence) return
      const shown = new Set(this.entries.map((entry) => entry.id))
      this.entries.push(...page.entries.filter((entry) => !shown.has(entry.id)))
      this.total = page.total
    } catch {
      // The button stays, so the person can ask again.
    } finally {
      if (sequence === this.sequence) this.loadingMore = false
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.sequence++
  }
}
