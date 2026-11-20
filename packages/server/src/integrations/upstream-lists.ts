import { z } from 'zod'
import type { Client } from '@modelcontextprotocol/client'
import { MAX_MCP_PROMPTS_PER_SERVER } from '@solus/contracts/integrations/prompts'
import { CALL_TIMEOUT_MS } from './call-progress'
import type { ServerFacts, UpstreamPrompt, UpstreamTool } from './upstream-session'

/**
 * What one server lists on one session (docs/plans/mcp-first-class.md §5.2,
 * §10): its tools and its MCP prompts, page by page, with the smallest `ttlMs`
 * of the pages. The gateway owns the sessions, the cache, and the sign-in
 * retry; this module owns what one list is. `resource-lists.ts` does the same
 * for resources (§11.1).
 */

/** A page's `ttlMs`, which a legacy server leaves out. */
const TTL = z.number().optional().catch(undefined)

/** The earlier of two expiries; a page without `ttlMs` changes nothing. */
function expiryWith(expiresAt: number | null, ttlMs: unknown, now: number): number | null {
  const ttl = TTL.parse(ttlMs)
  if (ttl === undefined) return expiresAt
  const pageExpiry = now + Math.max(0, ttl)
  return expiresAt === null ? pageExpiry : Math.min(expiresAt, pageExpiry)
}

export async function listUpstreamTools(client: Client, now: number): Promise<{ tools: UpstreamTool[]; expiresAt: number | null }> {
  const tools: UpstreamTool[] = []
  let expiresAt: number | null = null
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    expiresAt = expiryWith(expiresAt, page.ttlMs, now)
    for (const tool of page.tools) {
      tools.push({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations, _meta: tool._meta })
    }
    cursor = page.nextCursor
  } while (cursor)
  return { tools, expiresAt }
}

/** At most `MAX_MCP_PROMPTS_PER_SERVER` prompts. */
export async function listUpstreamPrompts(client: Client, now: number): Promise<{ prompts: UpstreamPrompt[]; expiresAt: number | null }> {
  const prompts: UpstreamPrompt[] = []
  let expiresAt: number | null = null
  let cursor: string | undefined
  do {
    // The gateway's own cache decides when to list; the SDK's must not answer for it.
    const page = await client.listPrompts(cursor ? { cursor } : undefined, { cacheMode: 'refresh', timeout: CALL_TIMEOUT_MS })
    expiresAt = expiryWith(expiresAt, page.ttlMs, now)
    for (const prompt of page.prompts) prompts.push({ name: prompt.name, title: prompt.title, description: prompt.description, arguments: prompt.arguments })
    cursor = prompts.length < MAX_MCP_PROMPTS_PER_SERVER ? page.nextCursor : undefined
  } while (cursor)
  prompts.splice(MAX_MCP_PROMPTS_PER_SERVER)
  return { prompts, expiresAt }
}

/** What the server said it can do, as the server facts keep it. */
export function serverCapabilitiesOf(client: Client): ServerFacts['capabilities'] {
  const capabilities = client.getServerCapabilities()
  return {
    prompts: !!capabilities?.prompts,
    resources: !!capabilities?.resources,
    resourceSubscribe: !!capabilities?.resources?.subscribe,
    tasks: !!capabilities?.extensions?.['io.modelcontextprotocol/tasks'],
  }
}
