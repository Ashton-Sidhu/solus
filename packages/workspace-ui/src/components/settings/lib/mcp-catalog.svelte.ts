import type { CatalogEntry, Integration } from '@solus/contracts/integration-types'
import { SvelteMap } from 'svelte/reactivity'
import { integrationsStore } from '../integrations.store.svelte'
import { afterAddStep, probeRefusal, urlHost } from './integration-labels'

/** An Add that runs, or the reason the last one stopped, for one server address. */
export type InstallState =
  | { kind: 'checking' }
  | { kind: 'adding' }
  | { kind: 'failed'; message: string }

export const CATALOG_PAGE_SIZE = 24
const SEARCH_DELAY_MS = 250

/**
 * The catalog of one MCP page on one host: search, a list that grows as the
 * person scrolls, and the one-step Add
 * (probe, create, then sign-in). Ephemeral: it lives as long as the page.
 */
export class McpCatalog {
  query = $state('')
  entries = $state<CatalogEntry[]>([])
  total = $state(0)
  /** The first page of a query is loading. */
  loading = $state(true)
  /** More entries are loading below the ones shown. */
  loadingMore = $state(false)
  error = $state('')
  /** By server address: an Add that runs or failed. A successful Add leaves no entry. */
  installs = new SvelteMap<string, InstallState>()
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly serverId: string, query = '') {
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

  /** Reads the first page of the query. */
  async load(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    const sequence = ++this.sequence
    this.loading = true
    this.loadingMore = false
    this.error = ''
    try {
      const page = await integrationsStore.catalogPage(this.serverId, this.query.trim(), 0, CATALOG_PAGE_SIZE)
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
      const page = await integrationsStore.catalogPage(this.serverId, this.query.trim(), this.entries.length, CATALOG_PAGE_SIZE)
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

  /**
   * Checks the server from the host, adds it, and starts the person's sign-in
   * when it needs one, so one action takes a server from the catalog to usable.
   * Null when it stopped; the reason is in `installs`.
   */
  async install(name: string, url: string): Promise<Integration | null> {
    const running = this.installs.get(url)
    if (running && running.kind !== 'failed') return null
    this.installs.set(url, { kind: 'checking' })
    const attempt = await integrationsStore.probe(this.serverId, url)
    const refusal = 'error' in attempt ? attempt.error : probeRefusal(attempt.result)
    if (refusal) {
      this.installs.set(url, { kind: 'failed', message: refusal })
      return null
    }
    this.installs.set(url, { kind: 'adding' })
    const integration = await integrationsStore.create(this.serverId, { name: name.trim() || urlHost(url), url })
    if (!integration) {
      const message = integrationsStore.states.get(this.serverId)?.writeError || 'Another change is saving. Try again.'
      integrationsStore.clearWriteError(this.serverId)
      this.installs.set(url, { kind: 'failed', message })
      return null
    }
    this.installs.delete(url)
    if (afterAddStep(integration.auth) === 'connect') void integrationsStore.connect(this.serverId, integration.id)
    return integration
  }

  dismiss(url: string): void {
    if (this.installs.get(url)?.kind === 'failed') this.installs.delete(url)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.sequence++
  }
}
