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

export const integrationUpdateRequestSchema = z.object({
  id: z.string().min(1),
  name: integrationNameSchema.optional(),
  url: integrationUrlSchema.optional(),
}).strict()
export type IntegrationUpdateRequest = z.infer<typeof integrationUpdateRequestSchema>

export const integrationIdRequestSchema = z.object({ id: z.string().min(1) }).strict()
export type IntegrationIdRequest = z.infer<typeof integrationIdRequestSchema>

export const integrationCatalogListRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict()
export type IntegrationCatalogListRequest = z.infer<typeof integrationCatalogListRequestSchema>

/** An integration or its tool list changed; read it again by id. */
export interface IntegrationChangedEvent {
  integrationId: string
  change: 'created' | 'updated' | 'removed' | 'tools'
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
