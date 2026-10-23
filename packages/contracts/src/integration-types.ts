/**
 * Integrations (docs/plans/mcp-integrations.md): a remote MCP server a host knows,
 * the catalog a person adds one from, and the probe that decides how it
 * authenticates. Phase 1 has anonymous MCP servers only: no connection, no policy,
 * no OpenAPI document. Zod is the contract so the clients and the host decode one
 * shape.
 */

import { z } from 'zod'
import { resourceRoleSchema } from './sharing'
import { firstPartyClientIdSchema } from './first-party-clients'

/**
 * How an integration authenticates (§3.2). `none`: tools work for everyone; `oauth`
 * is kept when the server also advertises it. `oauth`: each person signs in once.
 * `bearer`: each person pastes a key.
 */
export const integrationAuthSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none'),
    oauth: z.object({ discover: z.string().min(1) }).optional(),
  }),
  z.object({
    kind: z.literal('oauth'),
    /** The metadata address the server's challenge names. */
    discover: z.string().min(1),
    registration: z.enum(['dynamic', 'metadata-document', 'client-required']),
    /** A saved public client ID for a `client-required` server. The secret stays on the host. */
    clientId: z.string().min(1).optional(),
    /** True when the owner also saved a client secret. The secret itself never leaves the host. */
    hasClientSecret: z.boolean().optional(),
    /**
     * The server's authorization server is one Solus registered an app with
     * (§13.1): sign-in goes through that app and the person enters no client.
     * The owner's own client, when saved, still wins.
     */
    firstParty: firstPartyClientIdSchema.optional(),
  }),
  z.object({
    kind: z.literal('bearer'),
    scheme: z.enum(['bearer', 'basic', 'other', 'unspecified']),
  }),
])
export type IntegrationAuth = z.infer<typeof integrationAuthSchema>

/**
 * `mcp`: a remote MCP server at an HTTPS URL. `solus`: an MCP server Solus
 * writes and runs inside the host (§13.6), for a service with no usable one;
 * its `url` is the address `solus:<server id>`.
 */
export const integrationKindSchema = z.enum(['mcp', 'solus'])
export type IntegrationKind = z.infer<typeof integrationKindSchema>

const SOLUS_ADDRESS_PREFIX = 'solus:'

/** The address of a Solus MCP server (§13.6), in place of a URL. */
export const solusServerAddressSchema = z.string().regex(/^solus:[a-z0-9]+(?:-[a-z0-9]+)*$/)

export function solusServerAddress(serverId: string): string {
  return `${SOLUS_ADDRESS_PREFIX}${serverId}`
}

/** The Solus server an address names, or null for an HTTPS URL. */
export function solusServerIdOf(address: string): string | null {
  return solusServerAddressSchema.safeParse(address).success ? address.slice(SOLUS_ADDRESS_PREFIX.length) : null
}

/**
 * A root record (§3.3). Every integration is one person's (docs/plans/access-model.md,
 * D3): its owner alone sees, uses, and changes it. `slug` is the tool prefix,
 * unique among the owner's integrations in an organization.
 */
export const integrationSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  ownerKey: z.string().min(1),
  kind: integrationKindSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
  auth: integrationAuthSchema,
  /**
   * The upstream tools the owner turned off: agents do not see them and the
   * gateway refuses a call to one. A tool the server adds later is on.
   * A host from before this field sends none.
   */
  disabledTools: z.array(z.string()).default([]),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The reader's resource role (docs/plans/access-model.md §2.7): `owner` on every one a host answers, since an integration is personal. Absent in the store. */
  role: resourceRoleSchema.optional(),
})
export type Integration = z.infer<typeof integrationSchema>

/** One MCP entry of the integrations.sh feed (§3.1). `url` is the feed's `connectUrl`. Read on demand; never stored. */
export const catalogEntrySchema = z.object({
  id: z.string().min(1),
  kind: integrationKindSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  domain: z.string(),
  icon: z.string().optional(),
  categories: z.array(z.string()),
  popularity: z.number().nullable(),
  url: z.string().min(1),
  /** Set on an entry of the Solus catalog (§13.5); absent on the feed's. */
  source: z.literal('solus').optional(),
  /** The vendor's page for creating the OAuth client or the key the server needs (§13.5). */
  authHelp: z.string().optional(),
})
export type CatalogEntry = z.infer<typeof catalogEntrySchema>

/** One upstream tool as `tools/list` reported it. `readOnly` and `destructive` are the server's hints. */
export const integrationToolSummarySchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
})
export type IntegrationToolSummary = z.infer<typeof integrationToolSummarySchema>

/** What a tool does, from the server's own hints: a tool with no read-only hint may write. */
export type ToolAccess = 'Read' | 'Write' | 'Destructive'

export function toolAccess(tool: Pick<IntegrationToolSummary, 'readOnly' | 'destructive'>): ToolAccess {
  if (tool.destructive) return 'Destructive'
  return tool.readOnly ? 'Read' : 'Write'
}

/**
 * What the probe saw (§3.2). Signals record status, media type, challenge, and
 * metadata results; never a body or a URL.
 */
export const integrationProbeSignalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    method: z.enum(['initialize', 'tools/list']),
    status: z.number().int(),
    media: z.enum(['json', 'event-stream', 'html', 'text', 'other', 'none']),
    answer: z.enum(['result', 'error', 'none']),
    challenge: z.object({
      scheme: z.enum(['bearer', 'basic', 'other']),
      resourceMetadata: z.boolean(),
      scope: z.boolean(),
    }).optional(),
  }),
  z.object({
    kind: z.literal('resource-metadata'),
    result: z.enum(['ok', 'missing', 'invalid', 'mismatch', 'blocked']),
  }),
  z.object({
    kind: z.literal('authorization-server-metadata'),
    result: z.enum(['ok', 'missing', 'invalid', 'unsupported', 'blocked']),
  }),
])
export type IntegrationProbeSignal = z.infer<typeof integrationProbeSignalSchema>

const probeSignalsSchema = z.array(integrationProbeSignalSchema)

/** `undetermined` creates nothing: the person sees the reason and can retry. */
export const integrationProbeResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('anonymous'),
    auth: integrationAuthSchema,
    tools: z.array(integrationToolSummarySchema),
    signals: probeSignalsSchema,
  }),
  z.object({ outcome: z.literal('oauth'), auth: integrationAuthSchema, signals: probeSignalsSchema }),
  z.object({ outcome: z.literal('credentials-required'), auth: integrationAuthSchema, signals: probeSignalsSchema }),
  z.object({
    outcome: z.literal('undetermined'),
    reason: z.enum(['unavailable', 'unreachable', 'timeout', 'redirected', 'refused', 'not_mcp', 'initialize_error', 'tools_error', 'oauth_unusable']),
    signals: probeSignalsSchema,
  }),
])
export type IntegrationProbeResult = z.infer<typeof integrationProbeResultSchema>
export type IntegrationProbeUndeterminedReason = Extract<IntegrationProbeResult, { outcome: 'undetermined' }>['reason']

/** A custom URL (§3.1): HTTPS, with no credentials, query, fragment, or placeholder. */
export const integrationUrlSchema = z.string().trim().max(4096).refine((value) => {
  if (/[{}]|%7b|%7d/i.test(value)) return false
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  // A query is allowed: catalog entries carry server options such as PostHog's `mode=tools`.
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !value.includes('#')
}, 'Use an HTTPS address with no credentials or fragment')

const integrationNameSchema = z.string().trim().min(1).max(200)

/** An address a person may add: an HTTPS URL, or a Solus MCP server's address from the catalog. */
export const integrationAddressSchema = z.union([integrationUrlSchema, solusServerAddressSchema])

export const integrationProbeRequestSchema = z.object({ url: integrationAddressSchema }).strict()
export type IntegrationProbeRequest = z.infer<typeof integrationProbeRequestSchema>

/** The server derives `slug` from `name` when it is absent. */
export const integrationCreateRequestSchema = z.object({
  name: integrationNameSchema,
  url: integrationAddressSchema,
  slug: z.string().trim().min(1).max(40).optional(),
}).strict()
export type IntegrationCreateRequest = z.infer<typeof integrationCreateRequestSchema>

/**
 * The owner's OAuth client for a server with no dynamic registration
 * (§4.3). The host stores the secret; the client sends it once and never reads it back.
 */
export const integrationOAuthClientInputSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().max(4096).optional(),
}).strict()
export type IntegrationOAuthClientInput = z.infer<typeof integrationOAuthClientInputSchema>

/** `oauthClient`: an object saves the owner's client; `null` removes it. */
export const integrationUpdateRequestSchema = z.object({
  id: z.string().min(1),
  name: integrationNameSchema.optional(),
  url: integrationUrlSchema.optional(),
  oauthClient: z.union([integrationOAuthClientInputSchema, z.null()]).optional(),
  /** Replaces the whole list of tools turned off. */
  disabledTools: z.array(z.string().min(1).max(200)).max(1000).optional(),
}).strict()
export type IntegrationUpdateRequest = z.infer<typeof integrationUpdateRequestSchema>

export const integrationIdRequestSchema = z.object({ id: z.string().min(1) }).strict()
export type IntegrationIdRequest = z.infer<typeof integrationIdRequestSchema>

/**
 * The catalog's categories as Solus shows them. The feed's own category names
 * are few and inconsistent, so each Solus category gathers several of them.
 * Most entries have none and are listed under All only.
 */
export const catalogCategoryIdSchema = z.enum(['productivity', 'code', 'data', 'knowledge', 'design', 'communication', 'sales', 'finance', 'health'])
export type CatalogCategoryId = z.infer<typeof catalogCategoryIdSchema>

interface CatalogCategory {
  id: CatalogCategoryId
  label: string
  /** The feed's category names it gathers, in lower case. */
  feed: readonly string[]
}

/** In the order the MCP page lists them. */
export const CATALOG_CATEGORIES: readonly CatalogCategory[] = [
  { id: 'productivity', label: 'Productivity', feed: ['productivity', 'project-management', 'collaboration', 'automation'] },
  { id: 'code', label: 'Code and CI', feed: ['code', 'developer-tools', 'devtools', 'version-control', 'hosting', 'api', 'write code'] },
  { id: 'data', label: 'Data and analytics', feed: ['data', 'analytics', 'database', 'observability'] },
  { id: 'knowledge', label: 'Docs and knowledge', feed: ['documentation', 'knowledge-base', 'search', 'web-scraping'] },
  { id: 'design', label: 'Design', feed: ['design', 'creative'] },
  { id: 'communication', label: 'Communication', feed: ['communication'] },
  { id: 'sales', label: 'Sales and marketing', feed: ['sales-and-marketing', 'marketing', 'commerce', 'e-commerce', 'business', 'write copy'] },
  { id: 'finance', label: 'Finance', feed: ['financial-services', 'payments'] },
  { id: 'health', label: 'Health and science', feed: ['life-sciences', 'health'] },
]

/** True when the entry is in the Solus category. */
export function catalogEntryInCategory(entry: Pick<CatalogEntry, 'categories'>, categoryId: CatalogCategoryId): boolean {
  const feed = CATALOG_CATEGORIES.find((category) => category.id === categoryId)?.feed ?? []
  // A Solus catalog entry names the Solus category itself; a feed entry names the feed's.
  return entry.categories.some((name) => {
    const normalized = name.trim().toLowerCase()
    return normalized === categoryId || feed.includes(normalized)
  })
}

export const integrationCatalogListRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
  /** Only the entries of one Solus category. */
  category: catalogCategoryIdSchema.optional(),
  /** The first entry of the page, in popularity order. */
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict()
export type IntegrationCatalogListRequest = z.infer<typeof integrationCatalogListRequestSchema>

/** One page of the catalog. `total` counts every entry that matches the query. */
export interface CatalogPage {
  entries: CatalogEntry[]
  total: number
}

/** An integration or its tool list changed; read it again by id. */
export interface IntegrationChangedEvent {
  integrationId: string
  change: 'created' | 'updated' | 'removed' | 'tools'
}

/**
 * Per-person sign-in (§4). `needs-sign-in`: a refresh failed or the server
 * answered 401; the person signs in again. `cloud-unreachable`: the connection
 * lives in the account and Solus Cloud did not answer (plans/020 §5.2).
 * `needs-solus-sign-in`: the connection lives in the account and no Solus sign-in
 * lets this host read it; the person signs in to Solus, not to the server.
 */
export const integrationConnectionStatusSchema = z.enum(['connected', 'needs-sign-in', 'error', 'cloud-unreachable', 'needs-solus-sign-in'])
export type IntegrationConnectionStatus = z.infer<typeof integrationConnectionStatusSchema>

/**
 * The caller's own connection to one integration. It never carries the token:
 * the token stays in the host secret store (§4.1 rule 3).
 */
/** The account every person's first connection to an integration is (§13.3). */
/**
 * The input Solus adds to a tool when the person has several accounts (§13.3).
 * Prefixed, so a server's own `account` argument still reaches the server.
 */
export const ACCOUNT_INPUT = 'solus_account'

export const DEFAULT_INTEGRATION_ACCOUNT = 'default'

/** True for the person's first account. A host from before §13.3 sends no `accountId`: its one connection is the first. */
export function isFirstIntegrationAccount(connection: { accountId?: string }): boolean {
  return !connection.accountId || connection.accountId === DEFAULT_INTEGRATION_ACCOUNT
}

export const integrationConnectionSchema = z.object({
  integrationId: z.string().min(1),
  /**
   * Which of the person's accounts on this integration (§13.3): `default` for
   * the first, a minted id for each one added after it. A host from before
   * this field sends none.
   */
  accountId: z.string().min(1).max(64).default(DEFAULT_INTEGRATION_ACCOUNT),
  status: integrationConnectionStatusSchema,
  /**
   * Where the credential lives (plans/020-agent-profile.md §5): on this host, or
   * in the person's account, from which the host reads an access token per call.
   * `cloud-unreachable` is a `cloud` connection whose cached token ran out while
   * Solus Cloud did not answer; it is not a sign-in problem.
   */
  source: z.enum(['host', 'cloud']),
  label: z.string().nullable(),
  /** The account the server reported at `initialize`, when it reported one. */
  info: z.object({
    displayName: z.string().optional(),
    email: z.string().optional(),
    avatarUrl: z.string().optional(),
  }).nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
})
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>

/**
 * `waiting`: the host waits for the browser (§4.3). `callback` finishes on the
 * host's `/oauth/integration/callback`; `redirect-url` asks for the address the
 * browser ends on, for a browser that cannot reach the host. The end arrives as
 * `host.integrationAuthFinished`.
 * `token`: the integration takes a key; the card collects it and calls
 * `integrationConnectSubmit` with `id`.
 * `connected`: nothing to do in the browser (client credentials, or already connected).
 */
export const integrationConnectStartResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('waiting'),
    flowId: z.string().min(1),
    url: z.string().min(1),
    input: z.enum(['callback', 'redirect-url']),
    expiresAt: z.string(),
  }),
  /** `accountId`: the account the key is for, so the submit names it (§13.3). */
  z.object({ kind: z.literal('token'), integrationId: z.string().min(1), accountId: z.string().min(1).optional() }),
  z.object({ kind: z.literal('connected'), connection: integrationConnectionSchema }),
])
export type IntegrationConnectStartResult = z.infer<typeof integrationConnectStartResultSchema>

/** `callbackBaseUrl` is the origin the client reached the host on, as `googleConnect` takes it. */
export const integrationConnectStartRequestSchema = z.object({
  id: z.string().min(1),
  callbackBaseUrl: z.string().min(1).max(4096).optional(),
  /** The account to sign in again; left out, the first. */
  accountId: z.string().min(1).max(64).optional(),
  /** True to connect one more account (§13.3); the host names it. */
  newAccount: z.boolean().optional(),
}).strict()
export type IntegrationConnectStartRequest = z.infer<typeof integrationConnectStartRequestSchema>

/**
 * Exactly one target: `flowId` with the address an OAuth flow's browser ended on,
 * or `id` with an API key for a `bearer` integration.
 */
export const integrationConnectSubmitRequestSchema = z.object({
  flowId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  /** With `id`: the account the key is for; left out, the first. */
  accountId: z.string().min(1).max(64).optional(),
  value: z.string().trim().min(1).max(8192),
}).strict().refine((request) => (request.flowId === undefined) !== (request.id === undefined), 'Give a flowId or an integration id, not both')
export type IntegrationConnectSubmitRequest = z.infer<typeof integrationConnectSubmitRequestSchema>

export const integrationConnectCancelRequestSchema = z.object({ flowId: z.string().min(1) }).strict()
export type IntegrationConnectCancelRequest = z.infer<typeof integrationConnectCancelRequestSchema>

/** One of the caller's accounts on an integration (§13.3); left out, the first. */
export const integrationAccountRequestSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1).max(64).optional(),
}).strict()
export type IntegrationAccountRequest = z.infer<typeof integrationAccountRequestSchema>

/**
 * The caller's connection changed. `connection` is null after a disconnect,
 * and `accountId` then names the account that went. Delivered to that
 * person's clients only.
 */
export interface IntegrationConnectionChangedEvent {
  integrationId: string
  accountId?: string
  connection: IntegrationConnection | null
}

/** A `waiting` sign-in ended. Delivered to the clients of the person who started it. */
export interface IntegrationAuthFinishedEvent {
  flowId: string
  integrationId: string
  outcome: 'connected' | 'failed' | 'cancelled'
  message?: string
}

/** An integration tool returned `CONNECTION_REQUIRED` (§4.1 rule 2); the card offers Connect. */
export interface IntegrationConnectNeeded {
  integrationId: string
  integrationName: string
  /** The Solus session whose turn is waiting on the connection. */
  sessionId: string
}

const SLUG_MAX_LENGTH = 40

/** The tool prefix for a name: lowercase `[a-z0-9]` runs joined by `-`, at most 40 characters, never empty. */
export function integrationSlug(name: string): string {
  const slug = (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-').slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '')
  return slug || 'integration'
}

/** The Solus agent tool name for one upstream tool (§5.2.1): `<slug>__<tool>`. */
export function integrationToolName(slug: string, tool: string): string {
  return `${slug}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`
}
