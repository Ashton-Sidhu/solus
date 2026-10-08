/**
 * Integrations (docs/plans/mcp-integrations.md): a remote MCP server a host knows,
 * the catalog a person adds one from, and the probe that decides how it
 * authenticates. Phase 1 has anonymous MCP servers only: no connection, no policy,
 * no OpenAPI document. Zod is the contract so the clients and the host decode one
 * shape.
 */

import { z } from 'zod'

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
    /** True when the administrator also saved a client secret. The secret itself never leaves the host. */
    hasClientSecret: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('bearer'),
    scheme: z.enum(['bearer', 'basic', 'other', 'unspecified']),
  }),
])
export type IntegrationAuth = z.infer<typeof integrationAuthSchema>

export const integrationKindSchema = z.literal('mcp')
export type IntegrationKind = z.infer<typeof integrationKindSchema>

/** A root record (§3.3). `slug` is unique per organization and is the tool prefix. */
export const integrationSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  kind: integrationKindSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
  auth: integrationAuthSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
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

export const integrationProbeRequestSchema = z.object({ url: integrationUrlSchema }).strict()
export type IntegrationProbeRequest = z.infer<typeof integrationProbeRequestSchema>

/** The server derives `slug` from `name` when it is absent. */
export const integrationCreateRequestSchema = z.object({
  name: integrationNameSchema,
  url: integrationUrlSchema,
  slug: z.string().trim().min(1).max(40).optional(),
}).strict()
export type IntegrationCreateRequest = z.infer<typeof integrationCreateRequestSchema>

/**
 * An administrator's OAuth client for a server with no dynamic registration
 * (§4.3). The host stores the secret; the client sends it once and never reads it back.
 */
export const integrationOAuthClientInputSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().max(4096).optional(),
}).strict()
export type IntegrationOAuthClientInput = z.infer<typeof integrationOAuthClientInputSchema>

/** `oauthClient`: an object saves the administrator's client; `null` removes it. */
export const integrationUpdateRequestSchema = z.object({
  id: z.string().min(1),
  name: integrationNameSchema.optional(),
  url: integrationUrlSchema.optional(),
  oauthClient: z.union([integrationOAuthClientInputSchema, z.null()]).optional(),
}).strict()
export type IntegrationUpdateRequest = z.infer<typeof integrationUpdateRequestSchema>

export const integrationIdRequestSchema = z.object({ id: z.string().min(1) }).strict()
export type IntegrationIdRequest = z.infer<typeof integrationIdRequestSchema>

export const integrationCatalogListRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
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
 * answered 401; the person signs in again.
 */
export const integrationConnectionStatusSchema = z.enum(['connected', 'needs-sign-in', 'error'])
export type IntegrationConnectionStatus = z.infer<typeof integrationConnectionStatusSchema>

/**
 * The caller's own connection to one integration. It never carries the token:
 * the token stays in the host secret store (§4.1 rule 3).
 */
export const integrationConnectionSchema = z.object({
  integrationId: z.string().min(1),
  status: integrationConnectionStatusSchema,
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
  z.object({ kind: z.literal('token'), integrationId: z.string().min(1) }),
  z.object({ kind: z.literal('connected'), connection: integrationConnectionSchema }),
])
export type IntegrationConnectStartResult = z.infer<typeof integrationConnectStartResultSchema>

/** `callbackBaseUrl` is the origin the client reached the host on, as `googleConnect` takes it. */
export const integrationConnectStartRequestSchema = z.object({
  id: z.string().min(1),
  callbackBaseUrl: z.string().min(1).max(4096).optional(),
}).strict()
export type IntegrationConnectStartRequest = z.infer<typeof integrationConnectStartRequestSchema>

/**
 * Exactly one target: `flowId` with the address an OAuth flow's browser ended on,
 * or `id` with an API key for a `bearer` integration.
 */
export const integrationConnectSubmitRequestSchema = z.object({
  flowId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  value: z.string().trim().min(1).max(8192),
}).strict().refine((request) => (request.flowId === undefined) !== (request.id === undefined), 'Give a flowId or an integration id, not both')
export type IntegrationConnectSubmitRequest = z.infer<typeof integrationConnectSubmitRequestSchema>

export const integrationConnectCancelRequestSchema = z.object({ flowId: z.string().min(1) }).strict()
export type IntegrationConnectCancelRequest = z.infer<typeof integrationConnectCancelRequestSchema>

/** The caller's connection changed. `connection` is null after a disconnect. Delivered to that person's clients only. */
export interface IntegrationConnectionChangedEvent {
  integrationId: string
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
