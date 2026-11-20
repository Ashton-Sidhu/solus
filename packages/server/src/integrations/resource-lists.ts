import { z } from 'zod'
import type { Client, ReadResourceResult } from '@modelcontextprotocol/client'
import type { IntegrationResource, IntegrationResourceLists, IntegrationResourceTemplate } from '@solus/contracts/integration-types'

/**
 * The MCP resources of one server (docs/plans/mcp-first-class.md §11.1): its
 * lists, a template's expansion, and a read as MCP content. The gateway owns
 * the sessions and the cache; this module owns what one list or read is.
 */

/** Entries of one list kept for one server. A server can list millions; a person picks from a few. */
export const MAX_LISTED_RESOURCES = 200

/** The two lists of one server for one person, and when they expire (`ttlMs`), or null for "until a notification". */
export interface UpstreamResourceLists {
  resources: Array<Omit<IntegrationResource, 'integrationId'>>
  templates: Array<Omit<IntegrationResourceTemplate, 'integrationId'>>
  expiresAt: number | null
}

export const NO_RESOURCES: UpstreamResourceLists = { resources: [], templates: [], expiresAt: null }

/** Lists `resources/list` and `resources/templates/list` page by page, at most 200 entries each. */
export async function listUpstreamResources(client: Client, now: number): Promise<UpstreamResourceLists> {
  if (!client.getServerCapabilities()?.resources) return NO_RESOURCES
  const lists: UpstreamResourceLists = { resources: [], templates: [], expiresAt: null }
  const expire = (ttlMs: unknown) => {
    const ttl = z.number().safeParse(ttlMs)
    if (!ttl.success) return
    const expiry = now + Math.max(0, ttl.data)
    lists.expiresAt = lists.expiresAt === null ? expiry : Math.min(lists.expiresAt, expiry)
  }
  let cursor: string | undefined
  do {
    const page = await client.listResources({ cursor })
    expire(page.ttlMs)
    for (const resource of page.resources) {
      if (lists.resources.length >= MAX_LISTED_RESOURCES) break
      lists.resources.push(withoutEmpty({ uri: resource.uri, name: resource.name, title: resource.title, description: resource.description, mimeType: resource.mimeType, size: resource.size }))
    }
    cursor = lists.resources.length < MAX_LISTED_RESOURCES ? page.nextCursor : undefined
  } while (cursor)
  do {
    const page = await client.listResourceTemplates({ cursor })
    expire(page.ttlMs)
    for (const template of page.resourceTemplates) {
      if (lists.templates.length >= MAX_LISTED_RESOURCES) break
      lists.templates.push(withoutEmpty({ uriTemplate: template.uriTemplate, name: template.name, title: template.title, description: template.description, mimeType: template.mimeType }))
    }
    cursor = lists.templates.length < MAX_LISTED_RESOURCES ? page.nextCursor : undefined
  } while (cursor)
  return lists
}

/** The fields a server sent, without the ones it left out, so the reply has no `undefined`. */
function withoutEmpty<T extends object>(entry: T): T {
  // SAFETY: the entries are the same object less the keys whose value is undefined.
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as T
}

/** One server's lists as the client contract names them. */
export function resourceListsOf(integrationId: string, lists: UpstreamResourceLists): IntegrationResourceLists {
  return {
    resources: lists.resources.map((resource) => ({ integrationId, ...resource })),
    templates: lists.templates.map((template) => ({ integrationId, ...template })),
  }
}

/**
 * Expands a URI template with the values a person gave (§11.3). Only the two
 * simple operators of RFC 6570 level 2: `{name}` (each reserved character is
 * escaped) and `{+name}` (reserved characters stay). Any other operator, or a
 * missing value, is refused with the reason.
 */
export function expandUriTemplate(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(/\{([^}]*)\}/g, (_expression, body: string) => {
    const reserved = body.startsWith('+')
    const name = reserved ? body.slice(1) : body
    if (!/^[A-Za-z0-9_.%]+$/.test(name)) {
      throw new Error(`Solus expands only {name} and {+name} in a resource template, not {${body}}.`)
    }
    const value = values.get(name)
    if (value === undefined) throw new Error(`Give a value for ${name}.`)
    return reserved ? encodeURI(value).replace(/%25([0-9A-Fa-f]{2})/g, '%$1') : encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  })
}

/** A `resources/read` answer as MCP content, so the one mapper (`agentResultOf`, §6) reads it as it reads a tool result. */
export function readAsContent(result: ReadResourceResult): { content: Array<{ type: 'resource'; resource: ReadResourceResult['contents'][number] }> } {
  return { content: result.contents.map((resource) => ({ type: 'resource' as const, resource })) }
}
