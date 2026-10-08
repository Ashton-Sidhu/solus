import type { CatalogEntry, Integration, IntegrationProbeResult } from '@solus/contracts/integration-types'
import { integrationsStore } from '../integrations.store.svelte'
import { customUrlProblem, probeOutcomeText, urlHost, type ProbeOutcomeText } from './integration-labels'

export type ProbeStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'done'; result: IntegrationProbeResult }
  | { kind: 'failed'; error: string }

const SEARCH_DELAY_MS = 250

/**
 * The Add flow of one Integrations page on one host: catalog search, a custom
 * address, and the probe shown before Add. Ephemeral: it lives as long as the
 * page and is not shared.
 */
export class IntegrationAddFlow {
  query = $state('')
  results = $state<CatalogEntry[]>([])
  searching = $state(false)
  searchError = $state('')
  /** The query the results answer; differs from `query` while a search waits. */
  searchedQuery = $state('')
  activeIndex = $state(-1)
  customUrl = $state('')
  customUrlError = $state('')
  /** The integration about to be added. Null until a result or an address is chosen. */
  draft = $state<{ name: string; url: string } | null>(null)
  probe = $state<ProbeStatus>({ kind: 'idle' })
  private searchSequence = 0
  private probeSequence = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly serverId: string) {}

  get outcome(): ProbeOutcomeText | null {
    return this.probe.kind === 'done' ? probeOutcomeText(this.probe.result) : null
  }

  get canAdd(): boolean {
    return !!this.draft?.name.trim() && this.outcome?.canAdd === true
  }

  setQuery(value: string): void {
    this.query = value
    this.activeIndex = -1
    if (this.timer) clearTimeout(this.timer)
    this.searchSequence++
    if (!value.trim()) {
      this.results = []
      this.searching = false
      this.searchError = ''
      this.searchedQuery = ''
      return
    }
    this.searching = true
    this.timer = setTimeout(() => void this.search(), SEARCH_DELAY_MS)
  }

  async search(): Promise<void> {
    const query = this.query.trim()
    if (!query) return
    const sequence = ++this.searchSequence
    this.searching = true
    this.searchError = ''
    try {
      const results = await integrationsStore.searchCatalog(this.serverId, query)
      if (sequence !== this.searchSequence) return
      this.results = results
      this.activeIndex = results.length > 0 ? 0 : -1
    } catch {
      if (sequence !== this.searchSequence) return
      this.results = []
      this.searchError = 'The catalog is not available now. You can still add a custom URL.'
    }
    this.searchedQuery = query
    this.searching = false
  }

  /** Moves the highlighted result, wrapping at both ends. */
  moveActive(step: 1 | -1): void {
    const count = this.results.length
    if (count === 0) return
    this.activeIndex = (this.activeIndex + step + count) % count
  }

  selectActive(): void {
    const entry = this.results[this.activeIndex]
    if (entry) this.selectEntry(entry)
  }

  selectEntry(entry: CatalogEntry): void {
    this.draft = { name: entry.name, url: entry.url }
    void this.runProbe()
  }

  selectCustomUrl(): void {
    const url = this.customUrl.trim()
    const problem = customUrlProblem(url)
    this.customUrlError = problem ?? ''
    if (problem) return
    this.draft = { name: urlHost(url), url }
    void this.runProbe()
  }

  async runProbe(): Promise<void> {
    const draft = this.draft
    if (!draft) return
    const sequence = ++this.probeSequence
    this.probe = { kind: 'checking' }
    const attempt = await integrationsStore.probe(this.serverId, draft.url)
    if (sequence !== this.probeSequence) return
    this.probe = 'result' in attempt ? { kind: 'done', result: attempt.result } : { kind: 'failed', error: attempt.error }
  }

  async add(): Promise<Integration | null> {
    const draft = this.draft
    if (!draft || !this.canAdd) return null
    const integration = await integrationsStore.create(this.serverId, { name: draft.name.trim(), url: draft.url })
    if (integration) this.reset()
    return integration
  }

  /** Leaves the draft and starts again from search. */
  reset(): void {
    this.probeSequence++
    this.draft = null
    this.probe = { kind: 'idle' }
    this.customUrl = ''
    this.customUrlError = ''
    this.setQuery('')
    integrationsStore.clearWriteError(this.serverId)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.searchSequence++
    this.probeSequence++
  }
}
