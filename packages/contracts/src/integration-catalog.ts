import { z } from 'zod'
import { catalogCategoryIdSchema, integrationUrlSchema, type CatalogEntry } from './integration-types'
import bundledCatalog from './integration-catalog.json'

/**
 * The Solus catalog (docs/plans/mcp-integrations.md §13.5): MCP servers the
 * integrations.sh feed does not list. The file on `main` is the published
 * list; a host reads it on request and falls back to the copy its build
 * shipped with. An entry carries no auth fields: the probe decides how a
 * server signs in when a person adds it.
 */

export const solusCatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.literal('mcp'),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  domain: z.string().trim().min(1),
  categories: z.array(catalogCategoryIdSchema).min(1),
  url: integrationUrlSchema,
  icon: z.string().url().optional(),
  /** The vendor's page for creating the OAuth client or the key this server needs. */
  authHelp: z.string().url().optional(),
  /** The pages that prove the entry: the vendor's documentation and the server's metadata. */
  sources: z.array(z.string().url()).min(1),
}).strict()
export type SolusCatalogEntry = z.infer<typeof solusCatalogEntrySchema>

export const solusCatalogSchema = z.object({
  version: z.literal(1),
  entries: z.array(solusCatalogEntrySchema),
}).strict()
export type SolusCatalog = z.infer<typeof solusCatalogSchema>

/** The copy this build shipped with. */
export const BUNDLED_SOLUS_CATALOG: SolusCatalog = solusCatalogSchema.parse(bundledCatalog)

/** A Solus entry as the catalog lists it beside the feed's entries. */
export function solusCatalogEntry(entry: SolusCatalogEntry): CatalogEntry {
  const listed: CatalogEntry = {
    id: `solus:${entry.id}`,
    kind: 'mcp',
    slug: entry.id,
    name: entry.name,
    description: entry.description,
    domain: entry.domain,
    categories: entry.categories,
    popularity: null,
    url: entry.url,
    source: 'solus',
  }
  if (entry.icon) listed.icon = entry.icon
  if (entry.authHelp) listed.authHelp = entry.authHelp
  return listed
}
