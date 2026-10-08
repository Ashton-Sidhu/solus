import { describe, expect, test } from 'bun:test'
import { CATALOG_UNAVAILABLE_MESSAGE, IntegrationCatalog, applyMcpUrlDefaults, catalogEntryName } from '@solus/server/integrations/catalog'

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

function fakeFetch(answers: Array<() => Response>) {
  let calls = 0
  const fetchFn = (async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]
    calls++
    return answer()
  }) as unknown as typeof fetch
  return { fetch: fetchFn, calls: () => calls }
}

const ok = () => Response.json(FEED)
const down = () => new Response('nope', { status: 503 })

describe('integration catalog', () => {
  test('lists MCP entries with a URL, by popularity then name, and ignores unknown fields', async () => {
    // WHY: OpenAPI entries and entries without a server cannot be added in phase 1.
    const catalog = new IntegrationCatalog({ fetch: fakeFetch([ok]).fetch })
    const { entries } = await catalog.list()
    expect(entries.map((entry) => entry.id)).toEqual(['linear', 'deepwiki', 'cloudflare', 'posthog'])
    expect(entries[0]).toEqual({ id: 'linear', kind: 'mcp', slug: 'linear', name: 'Linear', description: 'Issues', domain: 'linear.app', icon: 'https://linear.app/icon.png', categories: [], popularity: 90, url: 'https://mcp.linear.app/mcp' })
    expect(entries.find((entry) => entry.id === 'posthog')?.popularity).toBeNull()
  })

  test('applies the product URL defaults unless the URL already names the option', async () => {
    // WHY: PostHog and Cloudflare otherwise hide their tools behind one wrapper tool.
    const { entries } = await new IntegrationCatalog({ fetch: fakeFetch([ok]).fetch }).list()
    expect(entries.find((entry) => entry.id === 'posthog')?.url).toBe('https://mcp.posthog.com/mcp?mode=tools')
    expect(entries.find((entry) => entry.id === 'cloudflare')?.url).toBe('https://mcp.cloudflare.com/mcp?codemode=true')
  })

  test('every Cloudflare server gets the code-mode switch, and agent suffixes leave names', () => {
    expect(applyMcpUrlDefaults('https://bindings.mcp.cloudflare.com/mcp')).toBe('https://bindings.mcp.cloudflare.com/mcp?codemode=false')
    expect(applyMcpUrlDefaults('https://mcp.notcloudflare.com/mcp')).toBe('https://mcp.notcloudflare.com/mcp')
    expect(catalogEntryName('Zoom for Claude')).toBe('Zoom')
    expect(catalogEntryName('Asana for ChatGPT')).toBe('Asana')
    expect(catalogEntryName('Claude Docs')).toBe('Claude Docs')
  })

  test('a query matches name, domain, description, and categories without case; limit cuts the list', async () => {
    const catalog = new IntegrationCatalog({ fetch: fakeFetch([ok]).fetch })
    expect((await catalog.list({ query: 'LINEAR' })).entries.map((entry) => entry.id)).toEqual(['linear'])
    expect((await catalog.list({ query: 'deepwiki.com' })).entries.map((entry) => entry.id)).toEqual(['deepwiki'])
    expect((await catalog.list({ query: 'any repository' })).entries.map((entry) => entry.id)).toEqual(['deepwiki'])
    expect((await catalog.list({ query: 'analytics' })).entries.map((entry) => entry.id)).toEqual(['posthog'])
    expect((await catalog.list({ limit: 2 })).entries.map((entry) => entry.id)).toEqual(['linear', 'deepwiki'])
  })

  test('offset and limit cut one page, and total counts every match', async () => {
    // WHY: the MCP page pages through more than a thousand entries; it shows "page of total".
    const catalog = new IntegrationCatalog({ fetch: fakeFetch([ok]).fetch })
    expect(await catalog.list({ offset: 2, limit: 2 })).toMatchObject({ total: 4, entries: [{ id: 'cloudflare' }, { id: 'posthog' }] })
    expect(await catalog.list({ offset: 3, limit: 2 })).toMatchObject({ total: 4, entries: [{ id: 'posthog' }] })
    expect(await catalog.list({ query: 'linear', offset: 1, limit: 2 })).toEqual({ total: 1, entries: [] })
  })

  test('a fresh copy is served without a fetch; a stale one is refetched and kept when the fetch fails', async () => {
    // WHY: a feed outage must not empty a list the person already saw.
    let now = 0
    const feed = fakeFetch([ok, down])
    const catalog = new IntegrationCatalog({ fetch: feed.fetch, now: () => now })
    await catalog.list()
    now = 60 * 60 * 1000
    await catalog.list()
    expect(feed.calls()).toBe(1)
    now = 5 * 60 * 60 * 1000
    expect((await catalog.list()).total).toBe(4)
    expect(feed.calls()).toBe(2)
  })

  test('with no copy at all, a failed fetch or an unknown envelope version is unavailable', async () => {
    await expect(new IntegrationCatalog({ fetch: fakeFetch([down]).fetch }).list()).rejects.toThrow(CATALOG_UNAVAILABLE_MESSAGE)
    const future = () => Response.json({ version: 2, data: FEED.data })
    await expect(new IntegrationCatalog({ fetch: fakeFetch([future]).fetch }).list()).rejects.toThrow(CATALOG_UNAVAILABLE_MESSAGE)
    const redirect = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/api.json' } })
    await expect(new IntegrationCatalog({ fetch: fakeFetch([redirect]).fetch }).list()).rejects.toThrow(CATALOG_UNAVAILABLE_MESSAGE)
  })
})
