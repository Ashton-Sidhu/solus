import { describe, expect, test } from 'bun:test'
import rawCatalog from '@solus/contracts/integration-catalog.json'
import { solusCatalogSchema } from '@solus/contracts/integration-catalog'
import { IntegrationCatalog } from '@solus/server/integrations/catalog'

/**
 * The published Solus catalog (docs/plans/mcp-integrations.md §13.5). An entry
 * ships by merging it on `main`, with no build to catch a mistake, so every
 * rule a host relies on is checked here.
 */

const catalog = solusCatalogSchema.parse(rawCatalog)

describe('integration-catalog.json', () => {
  test('matches the schema a host reads', () => {
    expect(solusCatalogSchema.safeParse(rawCatalog).success).toBe(true)
  })

  test('ids are unique and sorted, so two additions do not collide in review', () => {
    const ids = catalog.entries.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  test('every server is listed once, over HTTPS', () => {
    // WHY: the catalog merge replaces a feed entry by URL; a duplicate would list one server twice.
    const urls = catalog.entries.map((entry) => entry.url)
    expect(new Set(urls).size).toBe(urls.length)
    for (const url of urls) expect(new URL(url).protocol).toBe('https:')
  })

  test('every entry names the pages that prove it', () => {
    for (const entry of catalog.entries) expect(entry.sources.length).toBeGreaterThan(0)
  })
})

const feedServer = (id: string, connectUrl = `https://${id}.example/mcp`) => ({
  id, kind: 'mcp', slug: id, name: id, connectUrl,
})

function listFeed(data: Array<ReturnType<typeof feedServer> & { feeds?: string[] | string; popularity?: number }>, entries: typeof catalog.entries = []) {
  const fetchFeed = async (input: Parameters<typeof fetch>[0]) => String(input) === 'https://integrations.sh/api.json'
    ? Response.json({ version: 1, data })
    : Response.json({ version: 1, entries })
  return new IntegrationCatalog({
    solusServers: [],
    fetch: Object.assign(fetchFeed, { preconnect: fetch.preconnect }),
  }).list()
}

describe('third-party catalog trust', () => {
  test('requires at least one recognized source regardless of popularity', async () => {
    const { entries } = await listFeed([
      { ...feedServer('claude'), feeds: ['claude'] },
      { ...feedServer('curated'), feeds: ['curated'] },
      { ...feedServer('openai'), feeds: ['openai'] },
      { ...feedServer('multiple'), feeds: ['unknown', 'discovered', 'openai', 'claude'] },
      { ...feedServer('storefront', 'https://gsplantfoods.com/api/ucp/mcp'), feeds: ['discovered'], popularity: 100 },
      { ...feedServer('crawler-alias', 'https://claude.example/mcp'), feeds: ['discovered'] },
      { ...feedServer('unknown'), feeds: ['unknown'] },
      { ...feedServer('empty'), feeds: [] },
      { ...feedServer('malformed'), feeds: 'claude' },
      feedServer('missing'),
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['claude', 'curated', 'multiple', 'openai'])
  })

  test('keeps exact vendor-documented endpoints from the crawler', async () => {
    const { entries } = await listFeed([
      { ...feedServer('mux', 'https://mcp.mux.com'), feeds: ['discovered'] },
      { ...feedServer('new-relic', 'https://mcp.newrelic.com/mcp/'), feeds: ['discovered'] },
      { ...feedServer('render', 'https://mcp.render.com/mcp'), feeds: ['discovered'] },
      { ...feedServer('lookalike', 'https://mcp.render.com.example/mcp'), feeds: ['discovered'] },
      { ...feedServer('other-path', 'https://mcp.render.com/preview'), feeds: ['discovered'] },
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['mux', 'new-relic', 'render'])
  })

  test('excludes staging, a known early preview, and invalid remote addresses even with a recognized source', async () => {
    const { entries } = await listFeed([
      { ...feedServer('deel', 'https://api-staging.letsdeel.com/mcp'), feeds: ['openai'] },
      { ...feedServer('aris', 'https://aris.kongmy.dev/'), feeds: ['openai'] },
      { ...feedServer('local', 'stdio:example-mcp'), feeds: ['curated'] },
      { ...feedServer('http', 'http://example.com/mcp'), feeds: ['claude'] },
      { ...feedServer('malformed-url', 'missing address'), feeds: ['openai'] },
      { ...feedServer('embedded-credentials', 'https://user:password@example.com/mcp'), feeds: ['openai'] },
      { ...feedServer('airwallex', 'https://mcp-demo.airwallex.com/developer'), feeds: ['claude'] },
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['airwallex'])
  })

  test('the Solus catalog takes precedence over the feed trust rule', async () => {
    const url = 'https://staging.example.com/mcp'
    const [owned] = catalog.entries
    const { entries } = await listFeed([
      { ...feedServer('third-party', url), feeds: ['discovered'] },
    ], [{ ...owned, url }])
    expect(entries).toEqual([expect.objectContaining({ slug: owned.id, url, source: 'solus' })])
  })
})
