import { z } from 'zod'
import type { CatalogEntry, CatalogPage, IntegrationCatalogListRequest } from '@solus/contracts/integration-types'
import { createLogger } from '../logger'

const log = createLogger('main', 'integration-catalog')

/**
 * The integrations.sh feed (docs/plans/mcp-integrations.md §3.1): read on
 * request, never stored. The last good copy is kept in memory for four hours
 * and served when a fetch fails.
 */

const FEED_URL = 'https://integrations.sh/api.json'
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
 * Servers that hide their tools behind one wrapper tool unless asked, as
 * Executor applies them. An explicit value in the URL is kept.
 */
const MCP_QUERY_DEFAULTS = [
  { host: 'mcp.posthog.com', name: 'mode', value: 'tools' },
  // Every Cloudflare server (bindings., docs., observability., ...) shares the switch.
  { host: 'mcp.cloudflare.com', name: 'codemode', value: 'false' },
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
  return [entry.name, entry.domain, entry.description, ...entry.categories].some((field) => field.toLowerCase().includes(query))
}

function byPopularityThenName(a: CatalogEntry, b: CatalogEntry): number {
  return (b.popularity ?? -Infinity) - (a.popularity ?? -Infinity) || a.name.localeCompare(b.name)
}

export class IntegrationCatalog {
  private copy: { entries: CatalogEntry[]; fetchedAt: number } | null = null
  private pending: Promise<CatalogEntry[]> | null = null

  constructor(private readonly deps: { fetch?: typeof fetch; now?: () => number } = {}) {}

  async list(request: IntegrationCatalogListRequest = {}): Promise<CatalogPage> {
    const query = request.query?.trim().toLowerCase()
    const entries = await this.entries()
    const listed = (query ? entries.filter((entry) => matches(entry, query)) : [...entries]).sort(byPopularityThenName)
    const offset = request.offset ?? 0
    return { entries: listed.slice(offset, request.limit ? offset + request.limit : undefined), total: listed.length }
  }

  private async entries(): Promise<CatalogEntry[]> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.copy && now - this.copy.fetchedAt < FRESH_MS) return this.copy.entries
    this.pending ??= this.refresh().finally(() => { this.pending = null })
    return this.pending
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
