import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson } from './solus-server'

/**
 * Google Search Console as a Solus MCP server
 * (docs/plans/mcp-integrations.md §13.6). The tools are the ones agents use
 * most — sites, search performance, URL inspection, and sitemaps — over the
 * Search Console API, which serves the Webmasters v3 paths and the URL
 * Inspection v1 path from one host.
 */

const API = 'https://searchconsole.googleapis.com'

/** `webmasters` reads performance and inspects URLs, and submits and deletes sitemaps. */
export const GOOGLE_SEARCH_CONSOLE_SCOPES = ['https://www.googleapis.com/auth/webmasters'] as const

/** Search analytics rows stop here, below the API's 25,000, so an answer fits one tool result. */
const ROW_LIMIT_MAX = 1000

const siteUrl = z.string().min(1).describe('A property from list_sites: a URL-prefix property such as https://example.com/ (with the trailing slash), or a domain property such as sc-domain:example.com.')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD, in Pacific Time.')
const feedpath = z.url().describe('The full sitemap URL, such as https://example.com/sitemap.xml.')

function sitePath(site: string): string {
  return `${API}/webmasters/v3/sites/${encodeURIComponent(site)}`
}

const dimension = z.enum(['query', 'page', 'country', 'device', 'date', 'searchAppearance'])

export const googleSearchConsoleServer = new GoogleSolusServer({
  id: 'google-search-console',
  name: 'Google Search Console',
  description: 'Search performance, URL inspection, and sitemaps in Google Search Console.',
  domain: 'search.google.com',
  icon: 'https://ssl.gstatic.com/search-console/scfe/search_console-64.png',
  categories: ['data'],
  hosts: ['searchconsole.googleapis.com'],
  scopes: GOOGLE_SEARCH_CONSOLE_SCOPES,
  tools: [
    solusTool({
      name: 'list_sites',
      description: 'The Search Console properties the user can see, with their permission level.',
      input: z.object({}),
      readOnly: true,
      destructive: false,
      run: async (_input, { fetch }) => vendorJson(await fetch(`${API}/webmasters/v3/sites`)),
    }),
    solusTool({
      name: 'query_search_analytics',
      description: 'Clicks, impressions, CTR, and average position in Google Search for a property between two dates, grouped by the dimensions given.',
      input: z.object({
        siteUrl,
        startDate: date,
        endDate: date,
        dimensions: z.array(dimension).default([]).describe('How to group rows. No dimensions gives one total row.'),
        filters: z.array(z.object({
          dimension: dimension.exclude(['date']),
          operator: z.enum(['contains', 'equals', 'notContains', 'notEquals']),
          expression: z.string(),
        })).optional().describe('Filters that all must match, such as { dimension: "page", operator: "contains", expression: "/blog/" }.'),
        searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
        rowLimit: z.number().int().min(1).max(ROW_LIMIT_MAX).default(100),
        startRow: z.number().int().min(0).default(0).describe('The first row to give, for the next page.'),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const body = {
          startDate: input.startDate,
          endDate: input.endDate,
          dimensions: input.dimensions,
          type: input.searchType,
          rowLimit: input.rowLimit,
          startRow: input.startRow,
          dimensionFilterGroups: input.filters ? [{ groupType: 'and', filters: input.filters }] : undefined,
        }
        return vendorJson(await fetch(`${sitePath(input.siteUrl)}/searchAnalytics/query`, { method: 'POST', body: JSON.stringify(body) }))
      },
    }),
    solusTool({
      name: 'inspect_url',
      description: 'Google\'s index status of one URL in a property: whether it is indexed, its last crawl, canonical, mobile usability, and rich results.',
      input: z.object({
        inspectionUrl: z.url().describe('The full URL to inspect. It must be inside the property.'),
        siteUrl,
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${API}/v1/urlInspection/index:inspect`, {
        method: 'POST',
        body: JSON.stringify({ inspectionUrl: input.inspectionUrl, siteUrl: input.siteUrl }),
      })),
    }),
    solusTool({
      name: 'list_sitemaps',
      description: 'The sitemaps submitted for a property, with their status, errors, and warnings.',
      input: z.object({ siteUrl }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${sitePath(input.siteUrl)}/sitemaps`)),
    }),
    solusTool({
      name: 'submit_sitemap',
      description: 'Submit a sitemap for a property, or submit it again so Google reads it again.',
      input: z.object({ siteUrl, feedpath }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const response = await fetch(`${sitePath(input.siteUrl)}/sitemaps/${encodeURIComponent(input.feedpath)}`, { method: 'PUT' })
        if (!response.ok) await vendorJson(response)
        return { submitted: input.feedpath }
      },
    }),
    solusTool({
      name: 'delete_sitemap',
      description: 'Remove a sitemap from a property in Search Console. The file on the site stays.',
      input: z.object({ siteUrl, feedpath }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        const response = await fetch(`${sitePath(input.siteUrl)}/sitemaps/${encodeURIComponent(input.feedpath)}`, { method: 'DELETE' })
        if (!response.ok) await vendorJson(response)
        return { deleted: input.feedpath }
      },
    }),
  ],
})
