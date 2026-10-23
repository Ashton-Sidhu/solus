import { describe, expect, test } from 'bun:test'
import { CATALOG_UNAVAILABLE_MESSAGE, IntegrationCatalog, SOLUS_CATALOG_URL, applyMcpUrlDefaults, catalogEntryName } from '@solus/server/integrations/catalog'

// docs/plans/mcp-integrations.md §3.1: the catalog is the integrations.sh feed,
// read on request; the last good copy covers a failed fetch.

const FEED = {
  version: 1,
  generatedAt: '2026-10-08T00:00:00Z',
  data: [
    { id: 'deepwiki', kind: 'mcp', slug: 'deepwiki', name: 'DeepWiki', description: 'Docs for any repository', domain: 'deepwiki.com', categories: ['docs'], popularity: 50, connectUrl: 'https://mcp.deepwiki.com/mcp', extra: { ignored: true } },
    { id: 'linear', kind: 'mcp', slug: 'linear', name: 'Linear', description: 'Issues', domain: 'linear.app', popularity: 90, connectUrl: 'https://mcp.linear.app/mcp', icon: 'https://linear.app/icon.png' },
    { id: 'posthog', kind: 'mcp', slug: 'posthog', name: 'PostHog', description: 'Product analytics', domain: 'posthog.com', categories: ['analytics'], connectUrl: 'https://mcp.posthog.com/mcp' },
    { id: 'cloudflare', kind: 'mcp', slug: 'cloudflare', name: 'Cloudflare', description: '', domain: 'cloudflare.com', connectUrl: 'https://mcp.cloudflare.com/mcp?codemode=true' },
    { id: 'no-url', kind: 'mcp', slug: 'no-url', name: 'No URL', description: '', domain: 'example.com' },
    { id: 'petstore', kind: 'openapi', slug: 'petstore', name: 'Petstore', description: '', domain: 'petstore.io', connectUrl: 'https://petstore.io/openapi.json' },
    { id: 'broken', kind: 'mcp', slug: 'broken', name: 42, connectUrl: 'https://broken.example/mcp' },
  ],
}

const EMPTY_SOLUS = { version: 1, entries: [] }

/** Answers the feed from `answers`, in turn, and the Solus catalog from `solus`; `calls` counts the feed's. */
function fakeFetch(answers: Array<() => Response>, solus: () => Response = () => Response.json(EMPTY_SOLUS)) {
  let calls = 0
  let solusCalls = 0
  const fetchFn = (async (input: string | URL | Request) => {
    if (String(input) === SOLUS_CATALOG_URL) {
      solusCalls++
      return solus()
    }
    const answer = answers[Math.min(calls, answers.length - 1)]
    calls++
    return answer()
  }) as unknown as typeof fetch
  return { fetch: fetchFn, calls: () => calls, solusCalls: () => solusCalls }
}

const ok = () => Response.json(FEED)
const down = () => new Response('nope', { status: 503 })

describe('integration catalog', () => {
  test('lists MCP entries with a URL, by popularity then name, and ignores unknown fields', async () => {
    // WHY: OpenAPI entries and entries without a server cannot be added in phase 1.
    const catalog = new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok]).fetch })
    const { entries } = await catalog.list()
    expect(entries.map((entry) => entry.id)).toEqual(['linear', 'deepwiki', 'cloudflare', 'posthog'])
    expect(entries[0]).toEqual({ id: 'linear', kind: 'mcp', slug: 'linear', name: 'Linear', description: 'Issues', domain: 'linear.app', icon: 'https://linear.app/icon.png', categories: [], popularity: 90, url: 'https://mcp.linear.app/mcp' })
    expect(entries.find((entry) => entry.id === 'posthog')?.popularity).toBeNull()
  })

  test('applies the product URL defaults unless the URL already names the option', async () => {
    // WHY: PostHog otherwise hides its tools behind one wrapper tool.
    const { entries } = await new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok]).fetch }).list()
    expect(entries.find((entry) => entry.id === 'posthog')?.url).toBe('https://mcp.posthog.com/mcp?mode=tools')
    expect(entries.find((entry) => entry.id === 'cloudflare')?.url).toBe('https://mcp.cloudflare.com/mcp?codemode=true')
  })

  test('no Cloudflare URL gets codemode=false, and agent suffixes leave names', () => {
    // WHY: only the whole-API server reads it, and there it turns two tools into about 2,500 (§13.5).
    expect(applyMcpUrlDefaults('https://mcp.cloudflare.com/mcp')).toBe('https://mcp.cloudflare.com/mcp')
    expect(applyMcpUrlDefaults('https://bindings.mcp.cloudflare.com/mcp')).toBe('https://bindings.mcp.cloudflare.com/mcp')
    expect(catalogEntryName('Zoom for Claude')).toBe('Zoom')
    expect(catalogEntryName('Asana for ChatGPT')).toBe('Asana')
    expect(catalogEntryName('Claude Docs')).toBe('Claude Docs')
  })

  test('a query matches name, domain, description, and categories without case; limit cuts the list', async () => {
    const catalog = new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok]).fetch })
    expect((await catalog.list({ query: 'LINEAR' })).entries.map((entry) => entry.id)).toEqual(['linear'])
    expect((await catalog.list({ query: 'deepwiki.com' })).entries.map((entry) => entry.id)).toEqual(['deepwiki'])
    expect((await catalog.list({ query: 'any repository' })).entries.map((entry) => entry.id)).toEqual(['deepwiki'])
    expect((await catalog.list({ query: 'analytics' })).entries.map((entry) => entry.id)).toEqual(['posthog'])
    expect((await catalog.list({ limit: 2 })).entries.map((entry) => entry.id)).toEqual(['linear', 'deepwiki'])
  })

  test('a category lists the entries whose feed categories it gathers, and combines with a query', async () => {
    // WHY: the feed names categories inconsistently; one Solus category must find all of its names.
    const catalog = new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok]).fetch })
    expect((await catalog.list({ category: 'data' })).entries.map((entry) => entry.id)).toEqual(['posthog'])
    expect((await catalog.list({ category: 'knowledge' })).total).toBe(0)
    expect((await catalog.list({ category: 'data', query: 'linear' })).total).toBe(0)
  })

  test('offset and limit cut one page, and total counts every match', async () => {
    // WHY: the MCP page pages through more than a thousand entries; it shows "page of total".
    const catalog = new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok]).fetch })
    expect(await catalog.list({ offset: 2, limit: 2 })).toMatchObject({ total: 4, entries: [{ id: 'cloudflare' }, { id: 'posthog' }] })
    expect(await catalog.list({ offset: 3, limit: 2 })).toMatchObject({ total: 4, entries: [{ id: 'posthog' }] })
    expect(await catalog.list({ query: 'linear', offset: 1, limit: 2 })).toEqual({ total: 1, entries: [] })
  })

  test('a fresh copy is served without a fetch; a stale one is refetched and kept when the fetch fails', async () => {
    // WHY: a feed outage must not empty a list the person already saw.
    let now = 0
    const feed = fakeFetch([ok, down])
    const catalog = new IntegrationCatalog({ solusServers: [], fetch: feed.fetch, now: () => now })
    await catalog.list()
    now = 60 * 60 * 1000
    await catalog.list()
    expect(feed.calls()).toBe(1)
    now = 5 * 60 * 60 * 1000
    expect((await catalog.list()).total).toBe(4)
    expect(feed.calls()).toBe(2)
  })

  test('with no copy at all, a failed fetch or an unknown envelope version is unavailable', async () => {
    await expect(new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([down]).fetch }).list()).rejects.toThrow(CATALOG_UNAVAILABLE_MESSAGE)
    const future = () => Response.json({ version: 2, data: FEED.data })
    await expect(new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([future]).fetch }).list()).rejects.toThrow(CATALOG_UNAVAILABLE_MESSAGE)
    const redirect = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/api.json' } })
    await expect(new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([redirect]).fetch }).list()).rejects.toThrow(CATALOG_UNAVAILABLE_MESSAGE)
  })
})

describe('the Solus catalog (§13.5)', () => {
  const SOLUS = {
    version: 1,
    entries: [
      { id: 'salesforce-records', kind: 'mcp', name: 'Salesforce', description: 'Records', domain: 'salesforce.com', categories: ['sales'], url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all', authHelp: 'https://help.salesforce.com/setup', sources: ['https://api.salesforce.com/.well-known/oauth-protected-resource'] },
      { id: 'deepwiki-solus', kind: 'mcp', name: 'DeepWiki', description: 'Our corrected entry', domain: 'deepwiki.com', categories: ['knowledge'], url: 'https://mcp.deepwiki.com/mcp', sources: ['https://deepwiki.com'] },
    ],
  }
  const solusOk = () => Response.json(SOLUS)

  test('Solus entries come first, marked, with their setup link', async () => {
    const { entries } = await new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok], solusOk).fetch }).list()
    expect(entries.slice(0, 2).map((entry) => entry.slug)).toEqual(['deepwiki-solus', 'salesforce-records'])
    expect(entries.find((entry) => entry.slug === 'salesforce-records')).toMatchObject({ source: 'solus', authHelp: 'https://help.salesforce.com/setup' })
  })

  test('a Solus entry replaces the feed entry for the same server', async () => {
    // WHY: the Solus catalog also corrects a feed entry; one server must not be listed twice.
    const { entries } = await new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok], solusOk).fetch }).list()
    const deepwiki = entries.filter((entry) => entry.url === 'https://mcp.deepwiki.com/mcp')
    expect(deepwiki).toHaveLength(1)
    expect(deepwiki[0].description).toBe('Our corrected entry')
  })

  test('a Solus category names the category itself', async () => {
    const catalog = new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok], solusOk).fetch })
    expect((await catalog.list({ category: 'sales' })).entries.map((entry) => entry.slug)).toEqual(['salesforce-records'])
  })

  test('a published copy this build cannot read falls back to the bundled one', async () => {
    // WHY: a newer Solus may publish a field this one does not know; the list must not empty.
    const future = () => Response.json({ version: 2, entries: [] })
    const { entries } = await new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([ok], future).fetch }).list()
    expect(entries.filter((entry) => entry.source === 'solus').map((entry) => entry.slug)).toContain('cloudflare-api')
  })

  test('the Solus catalog still lists when the feed is unavailable', async () => {
    const { entries } = await new IntegrationCatalog({ solusServers: [], fetch: fakeFetch([down], solusOk).fetch }).list()
    expect(entries.map((entry) => entry.slug)).toEqual(['deepwiki-solus', 'salesforce-records'])
  })
})

describe('Solus MCP servers in the catalog (§13.6)', () => {
  test('the servers this build runs are listed first, by their solus: address', async () => {
    const { entries } = await new IntegrationCatalog({ fetch: fakeFetch([ok]).fetch }).list()
    const solus = entries.filter((entry) => entry.kind === 'solus')
    // WHY: a server only this build runs is found before any feed entry for the same service.
    expect(entries.slice(0, solus.length)).toEqual(solus)
    expect(solus.find((entry) => entry.url === 'solus:google-calendar')).toMatchObject({ name: 'Google Calendar', source: 'solus' })
  })
})
