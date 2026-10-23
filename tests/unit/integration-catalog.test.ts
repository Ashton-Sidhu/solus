import { describe, expect, test } from 'bun:test'
import rawCatalog from '@solus/contracts/integration-catalog.json'
import { solusCatalogSchema } from '@solus/contracts/integration-catalog'

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
