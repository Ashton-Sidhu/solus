import { z } from 'zod'
import { catalogEntryInCategory, type CatalogEntry, type CatalogPage, type IntegrationCatalogListRequest } from '@solus/contracts/integration-types'
import { BUNDLED_SOLUS_CATALOG, solusCatalogEntry, solusCatalogSchema } from '@solus/contracts/integration-catalog'
import { createLogger } from '../logger'
import { solusServerCatalogEntries } from './solus-servers'

const log = createLogger('main', 'integration-catalog')

/**
 * The integrations.sh feed (docs/plans/mcp-integrations.md §3.1): read on
 * request, never stored. The last good copy is kept in memory for four hours
 * and served when a fetch fails.
 */

const FEED_URL = 'https://integrations.sh/api.json'
/** The Solus catalog's published copy (docs/plans/mcp-integrations.md §13.5): merging a change to it on `main` releases an entry. */
export const SOLUS_CATALOG_URL = 'https://raw.githubusercontent.com/Ashton-Sidhu/solus/main/packages/contracts/src/integration-catalog.json'
const FETCH_TIMEOUT_MS = 30_000
const FRESH_MS = 4 * 60 * 60 * 1000

export const CATALOG_UNAVAILABLE_MESSAGE = 'The integration catalog is unavailable. Try again.'

/** No copy of the feed at all: the fetch failed and nothing was kept. */
export class IntegrationCatalogUnavailableError extends Error {
  constructor() {
    super(CATALOG_UNAVAILABLE_MESSAGE)
    this.name = 'IntegrationCatalogUnavailableError'
  }
}

const envelopeSchema = z.object({ version: z.literal(1), data: z.array(z.unknown()) })

// Unknown fields are ignored; a field of the wrong type drops only its entry.
const feedEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.string(),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  domain: z.string().nullish(),
  icon: z.string().nullish(),
  categories: z.array(z.string()).nullish(),
  popularity: z.number().nullish(),
  connectUrl: z.string().min(1).nullish(),
})

/**
 * Servers that hide their tools behind one wrapper tool unless asked. Solus
 * lists one tool per upstream tool, so the per-tool switches and approval
 * work. An explicit value in the URL is kept. Cloudflare's `codemode=false`
 * is not here: only its whole-API server reads it, and there it turns two
 * tools into about 2,500 (§13.5).
 */
const MCP_QUERY_DEFAULTS = [
  // PostHog otherwise wraps every tool in one `exec` tool.
  { host: 'mcp.posthog.com', name: 'mode', value: 'tools' },
]

/** The registry names connector-directory entries after the agent they were listed for; the service is the same. */
export function catalogEntryName(name: string): string {
  return name.replace(/\s+for\s+(Claude|ChatGPT)$/i, '').trim() || name
}

export function applyMcpUrlDefaults(href: string): string {
  if (!URL.canParse(href)) return href
  const url = new URL(href)
  let changed = false
  for (const rule of MCP_QUERY_DEFAULTS) {
    const sameHost = url.hostname === rule.host || url.hostname.endsWith(`.${rule.host}`)
    if (!sameHost || url.searchParams.has(rule.name)) continue
    url.searchParams.set(rule.name, rule.value)
    changed = true
  }
  return changed ? url.href : href
}

function entriesOf(envelope: z.infer<typeof envelopeSchema>): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const item of envelope.data) {
    const parsed = feedEntrySchema.safeParse(item)
    if (!parsed.success) continue
    const { connectUrl, ...entry } = parsed.data
    if (entry.kind !== 'mcp' || !connectUrl) continue
    const mapped: CatalogEntry = {
      id: entry.id,
      kind: 'mcp',
      slug: entry.slug,
      name: catalogEntryName(entry.name),
      description: entry.description ?? '',
      domain: entry.domain ?? '',
      categories: entry.categories ?? [],
      popularity: entry.popularity ?? null,
      url: applyMcpUrlDefaults(connectUrl),
    }
    if (entry.icon) mapped.icon = entry.icon
    entries.push(mapped)
  }
  return entries
}

function matches(entry: CatalogEntry, query: string): boolean {
  // `id` and `slug` too: `connect_integration` names an entry by the `service` value it returned.
  return [entry.id, entry.slug, entry.name, entry.domain, entry.description, ...entry.categories].some((field) => field.toLowerCase().includes(query))
}

/** Solus entries first, then by popularity, then by name. */
function bySourceThenPopularity(a: CatalogEntry, b: CatalogEntry): number {
  const solusFirst = Number(b.source === 'solus') - Number(a.source === 'solus')
  return solusFirst || (b.popularity ?? -Infinity) - (a.popularity ?? -Infinity) || a.name.localeCompare(b.name)
}

/** The Solus catalog's entries, and the feed's entries for every server the Solus catalog does not list. */
export function mergeCatalogs(solus: CatalogEntry[], feed: CatalogEntry[]): CatalogEntry[] {
  const solusUrls = new Set(solus.map((entry) => entry.url))
  return [...solus, ...feed.filter((entry) => !solusUrls.has(entry.url))]
}

export class IntegrationCatalog {
  private copy: { entries: CatalogEntry[]; fetchedAt: number } | null = null
  private pending: Promise<CatalogEntry[]> | null = null
  private solusCopy: { entries: CatalogEntry[]; fetchedAt: number } | null = null
  private solusPending: Promise<CatalogEntry[]> | null = null

  /** `solusServers`: the Solus MCP servers this build runs (§13.6); the real ones unless a test names its own. */
  constructor(private readonly deps: { fetch?: typeof fetch; now?: () => number; solusServers?: CatalogEntry[] } = {}) {}

  async list(request: IntegrationCatalogListRequest = {}): Promise<CatalogPage> {
    const query = request.query?.trim().toLowerCase()
    // The Solus MCP servers this build runs, then the published Solus catalog (§13.5, §13.6).
    const solus = [...(this.deps.solusServers ?? solusServerCatalogEntries()), ...await this.solusEntries()]
    // The Solus catalog still lists when the feed is unavailable.
    const feed = await this.entries().catch((error) => {
      if (error instanceof IntegrationCatalogUnavailableError && solus.length) return []
      throw error
    })
    const entries = mergeCatalogs(solus, feed)
    const { category } = request
    const listed = entries
      .filter((entry) => (!query || matches(entry, query)) && (!category || catalogEntryInCategory(entry, category)))
      .sort(bySourceThenPopularity)
    const offset = request.offset ?? 0
    return { entries: listed.slice(offset, request.limit ? offset + request.limit : undefined), total: listed.length }
  }

  private async entries(): Promise<CatalogEntry[]> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.copy && now - this.copy.fetchedAt < FRESH_MS) return this.copy.entries
    this.pending ??= this.refresh().finally(() => { this.pending = null })
    return this.pending
  }

  /** The published Solus catalog, kept four hours; the bundled copy when it cannot be read. Never throws. */
  private async solusEntries(): Promise<CatalogEntry[]> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.solusCopy && now - this.solusCopy.fetchedAt < FRESH_MS) return this.solusCopy.entries
    this.solusPending ??= this.refreshSolus().finally(() => { this.solusPending = null })
    return this.solusPending
  }

  private async refreshSolus(): Promise<CatalogEntry[]> {
    try {
      const response = await (this.deps.fetch ?? fetch)(process.env.SOLUS_INTEGRATION_CATALOG_URL || SOLUS_CATALOG_URL, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      })
      if (response.status !== 200) throw new Error(`status ${response.status}`)
      const entries = solusCatalogSchema.parse(await response.json()).entries.map(solusCatalogEntry)
      this.solusCopy = { entries, fetchedAt: this.deps.now?.() ?? Date.now() }
      return entries
    } catch (error) {
      // A copy this build cannot read, or no network: the last good copy, else the bundled one.
      log.warn('solus_catalog_fetch_failed', { error: error instanceof Error ? error.message : String(error), hasCopy: this.solusCopy !== null })
      return this.solusCopy?.entries ?? BUNDLED_SOLUS_CATALOG.entries.map(solusCatalogEntry)
    }
  }

  private async refresh(): Promise<CatalogEntry[]> {
    try {
      const response = await (this.deps.fetch ?? fetch)(FEED_URL, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      })
      if (response.status !== 200) throw new Error(`status ${response.status}`)
      const entries = entriesOf(envelopeSchema.parse(await response.json()))
      this.copy = { entries, fetchedAt: this.deps.now?.() ?? Date.now() }
      return entries
    } catch (error) {
      log.warn('integration_catalog_fetch_failed', { error: error instanceof Error ? error.message : String(error), hasCopy: this.copy !== null })
      if (this.copy) return this.copy.entries
      throw new IntegrationCatalogUnavailableError()
    }
  }
}
