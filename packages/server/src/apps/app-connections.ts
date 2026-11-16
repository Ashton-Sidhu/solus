import { z } from 'zod'
import { CONNECTION_LABELS, type ConnectionProvider } from '@solus/contracts/connections'
import { atlassianRequest, connectedSite } from '../atlassian/api'
import { loadCredential as loadAtlassianCredential } from '../atlassian/token-store'
import { getAccessToken as getGoogleAccessToken } from '../google/oauth'
import { githubCredentials } from '../providers/github/credentials'
import { runGithubRequest } from '../providers/github/request'
import type { StoredValue } from './app-storage'

/**
 * The built-in connections as an app's roles (docs/plans/apps.md §5): GitHub,
 * Atlassian, and Google, each with one tool, `request`, that sends one REST
 * call with the acting person's own credential. The host adds the credential,
 * so the app's code never holds it, and a path can only reach that provider's
 * API.
 */

/** The one tool of a built-in connection. */
export const CONNECTION_TOOL = 'request'

/** What an app reaches on the built-in connections; `hostConnections` on a host. */
export interface AppConnections {
  /** Whether the acting person can reach this provider now. */
  connected(provider: ConnectionProvider): Promise<boolean>
  /** One `request` call as the acting person. */
  request(provider: ConnectionProvider, input: StoredValue): Promise<StoredValue>
}

const GITHUB_HOST = 'github.com'
const GOOGLE_API = 'https://www.googleapis.com'

/** A path on the provider's API: one leading `/`, so it cannot name another host. */
const pathSchema = z.string().regex(/^\/(?!\/)/, 'A path starts with one /, for example /user.')
const queryScalarSchema = z.union([z.string(), z.number(), z.boolean()]).transform(String)
/**
 * A URL takes text: a number or a boolean such as `per_page: 100` is sent as
 * its text, a list such as `fields: ['summary', 'status']` as one
 * comma-separated value, and a null is left out.
 */
const querySchema = z.record(z.string(), z.union([queryScalarSchema, z.array(queryScalarSchema).transform((values) => values.join(',')), z.null()]))
  .transform((query): { [key: string]: string } => Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== null)))
  .optional()

/** `get` and `GET` are the same method. */
function methodSchema<const Methods extends readonly [string, ...string[]]>(methods: Methods) {
  return z.string().transform((method) => method.toUpperCase()).pipe(z.enum(methods)).default(methods[0])
}

const requestSchema = z.object({
  method: methodSchema(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: pathSchema,
  query: querySchema,
  body: z.json().optional(),
})

/** Confluence's paths start with `/wiki/`; a request that names no product and another path is for Jira. */
const atlassianRequestSchema = z.object({
  product: z.enum(['jira', 'confluence']).optional(),
  method: methodSchema(['GET', 'POST', 'PUT', 'DELETE']),
  path: pathSchema,
  query: querySchema,
  body: z.json().optional(),
}).transform((request) => ({ ...request, product: request.product ?? (request.path.startsWith('/wiki/') ? 'confluence' as const : 'jira' as const) }))

/** The request, or an error that says in one line what is wrong with it. */
function parsed<Schema extends z.ZodType>(schema: Schema, input: StoredValue): z.output<Schema> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new Error(`This request is not one the ${CONNECTION_TOOL} tool takes: ${z.prettifyError(result.error).replaceAll('\n', ' ')}`)
}

function withQuery(path: string, query: { [key: string]: string } | undefined): string {
  const search = new URLSearchParams(query).toString()
  return search ? `${path}${path.includes('?') ? '&' : '?'}${search}` : path
}

async function githubCall(input: StoredValue): Promise<StoredValue> {
  const { method, path, query, body } = parsed(requestSchema, input)
  const clients = await githubCredentials().clients(GITHUB_HOST)
  const url = withQuery(path, query)
  const data = await runGithubRequest('app_request', GITHUB_HOST, clients, async (client) => (
    body === undefined ? await client.rest.request({ method, url }) : await client.rest.request({ method, url, data: body })
  ).data)
  return z.json().parse(data ?? null)
}

async function atlassianCall(input: StoredValue): Promise<StoredValue> {
  const { product, method, path, query, body } = parsed(atlassianRequestSchema, input)
  const site = await connectedSite(product)
  if (!site) throw new Error(`Connect Atlassian with ${product} access in Settings → Integrations to use this app.`)
  return (await atlassianRequest({ product, cloudId: site.cloudId, method, path, query, body }, z.json().optional())) ?? null
}

async function googleCall(input: StoredValue): Promise<StoredValue> {
  const { method, path, query, body } = parsed(requestSchema, input)
  const token = await getGoogleAccessToken()
  if (!token) throw new Error(`Connect ${CONNECTION_LABELS.google} in Settings → Integrations to use this app.`)
  const headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' })
  if (body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`${GOOGLE_API}${withQuery(path, query)}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`Google refused the call (${response.status}): ${text.slice(0, 500)}`)
  if (!text) return null
  return response.headers.get('content-type')?.includes('json') ? z.json().parse(JSON.parse(text)) : text
}

const CALLS = {
  github: githubCall,
  atlassian: atlassianCall,
  google: googleCall,
} satisfies { [provider in ConnectionProvider]: (input: StoredValue) => Promise<StoredValue> }

const CONNECTED = {
  github: async () => (await githubCredentials().chain(GITHUB_HOST)).length > 0,
  atlassian: async () => (await loadAtlassianCredential()) !== null,
  google: async () => (await getGoogleAccessToken()) !== null,
} satisfies { [provider in ConnectionProvider]: () => Promise<boolean> }

export const hostConnections: AppConnections = {
  connected: (provider) => CONNECTED[provider]().catch(() => false),
  request: (provider, input) => CALLS[provider](input),
}
