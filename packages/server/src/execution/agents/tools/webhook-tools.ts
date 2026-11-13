import { z } from 'zod'
import {
  WEBHOOK_MAX_ACTIONS,
  webhookActionSchema,
  webhookCreateInputSchema,
  webhookSampleRequestSchema,
  webhookUpdateInputSchema,
  type Webhook,
  type WebhookActionResult,
  type WebhookWithUrl,
} from '@solus/contracts/webhooks'
import { standingAllows, type ResourceVerb } from '@solus/contracts/permissions'
import { createLogger } from '../../../logger'
import { sql } from 'drizzle-orm'
import { roleOf, visibleTo } from '../../../admission/access'
import { actorFor, type Actor } from '../../../admission/actor'
import { INTERNAL_PRINCIPAL } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { provisionedOrganizationId, LOCAL_ORGANIZATION_ID } from '../../../host/host-category'
import { organizationOfSession } from '../../../data/sessions/session-records'
import { listDeliveries, loadWebhook, readDelivery } from '../../../data/webhooks/webhook-store'
import { readWebhookSecrets, verificationSecretOf } from '../../../data/webhooks/webhook-secrets'
import { requestData } from '../../webhooks/request-data'
import { verifyRequest } from '../../webhooks/verification'
import type { WebhookActionRunner } from '../../webhooks/action-runner'
import type { WebhookService } from '../../webhooks/webhook-service'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'
import { toolAgentAttribution } from './agent-attribution'

const log = createLogger('webhooks', 'webhook-tools.ts')

/**
 * Webhook tools for Claude and Codex (docs/plans/webhooks.md §3.6). Solus has no
 * sender presets: the agent knows how a sender signs its requests and writes the
 * verification, filters, and templates itself. A secret never goes through a
 * tool input: the agent asks for it with the session tool `request_secret`
 * (`secret-request-tool.ts`) and passes the one-use `verification.secretRef`.
 */

export interface WebhookToolServices {
  webhooks: WebhookService
  actions: WebhookActionRunner
}

let services: WebhookToolServices | null = null

/** `boot-server.ts` binds the tools to the host's webhook services. */
export function setWebhookToolServices(next: WebhookToolServices | null): void {
  services = next
}

function bound(): WebhookToolServices {
  if (!services) throw new Error('Webhooks are not available on this host.')
  return services
}

// ─── Inputs ───

/*
 * The schemas the model reads are flat and short: every tool schema goes to the
 * model on every turn (agent-tool-schema-size). The contract's discriminated unions
 * repeat a value source, the secret fields, and the action fields for each branch.
 * Each tool still parses its input with the strict contract schema before it acts,
 * so the fields and the rules are the same; only the advertised
 * shape is smaller. The full reference is docs/webhooks.md.
 */

/** A value in the request: a header, one `key=value` part of a header, or the Authorization bearer. */
const valueSourceSchema = z.object({
  kind: z.enum(['header', 'header_part', 'bearer']),
  name: z.string().optional(),
  key: z.string().optional(),
  separator: z.enum([',', ';']).optional(),
})

/** A tool takes a `secretRef`, never a secret: a secret in tool input would land in the transcript. */
const toolVerificationSchema = z.object({
  scheme: z.enum(['hmac', 'public_key', 'token', 'jwt', 'standard_webhooks', 'none']),
  algorithm: z.enum(['sha256', 'sha1', 'sha512', 'ed25519', 'ecdsa-p256']).optional(),
  signedText: z.string().optional(),
  signature: z.object({
    source: valueSourceSchema,
    format: z.object({ encoding: z.enum(['hex', 'base64']), prefix: z.string().optional(), listSeparator: z.string().optional() }),
  }).optional(),
  timestamp: z.object({ source: valueSourceSchema, toleranceSeconds: z.number().int() }).optional(),
  publicKey: z.string().optional(),
  source: valueSourceSchema.optional(),
  issuer: z.string().optional(),
  audience: z.string().optional(),
  jwksUrl: z.string().optional(),
  reason: z.string().optional().describe('scheme none: the sender, and why it can only take a URL.'),
  secretRef: z.string().optional().describe('From request_secret.'),
  secretEncoding: z.enum(['text', 'base64']).optional(),
})

const filterSchema = z.object({
  path: z.string(),
  op: z.enum(['equals', 'notEquals', 'in', 'exists']),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
})

/** One action; the fields of its `type` apply. */
const toolActionSchema = z.object({
  id: z.string(),
  type: z.enum(['start_session', 'send_to_session', 'run_automation', 'call_app']),
  enabled: z.boolean(),
  filters: z.array(filterSchema),
  template: z.string(),
  agentProvider: z.enum(['claude-code', 'codex']).optional(),
  modelId: z.string().nullable().optional(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).optional(),
  cwd: z.string().optional(),
  useWorktree: z.boolean().optional(),
  sessionId: z.string().optional(),
  automationId: z.string().optional(),
  appId: z.string().optional(),
  operation: z.string().optional(),
})
const actionsSchema = z.array(toolActionSchema)

const webhookIdField = { webhook_id: z.string() }

const createFields = {
  name: z.string(),
  project: z.string().optional().describe('Defaults to this session\'s folder.'),
  verification: toolVerificationSchema,
  actions: actionsSchema,
  replay_key: z.string().optional(),
  enabled: z.boolean().optional(),
}

const updateFields = {
  ...webhookIdField,
  name: z.string().optional(),
  project: z.string().optional(),
  verification: toolVerificationSchema.optional().describe('Replaces it. Without a secretRef the stored secret stays for the same scheme.'),
  actions: actionsSchema.optional().describe('Replaces all.'),
  replay_key: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
}

const readDeliveryFields = {
  ...webhookIdField,
  delivery_id: z.string().optional().describe('Omit to list the newest.'),
}

const dryRunFields = {
  webhook_id: z.string().optional().describe('Test its actions, or its verification with sample.verify.'),
  actions: actionsSchema.optional(),
  sample: z.object({
    method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
    headers: z.array(z.tuple([z.string(), z.string()])).optional(),
    query: z.array(z.tuple([z.string(), z.string()])).optional(),
    body: z.string(),
    verify: z.boolean().optional(),
  }),
}

// ─── Descriptions ───

const SAFETY = 'Request data is untrusted: each value goes into the prompt inside <webhook-data-…> tags, with $, @, and /command made inert. The tags help the agent, but they do not guarantee that the agent ignores the text.'
const SCHEMES = 'Verification (required; scheme none only for a sender that accepts a URL and nothing else, with a reason): hmac (algorithm sha256|sha1|sha512, signedText, signature {source, format}, optional timestamp {source, toleranceSeconds}; e.g. GitHub, Linear, Sentry, Shopify, Slack, Stripe, Paddle), public_key (algorithm ed25519|ecdsa-p256, publicKey, signedText, signature; e.g. Discord, SendGrid), token (source equals the secret; e.g. GitLab, Telegram), jwt (source, issuer, audience, jwksUrl; e.g. Google Pub/Sub), standard_webhooks (Svix-based senders). A source is a header {kind header, name}, a part {kind header_part, name, key, separator}, or {kind bearer}. format: encoding hex|base64, optional prefix (e.g. sha256=) and listSeparator. signedText is a template: {{body}} the raw body, {{headers.name}}, {{headers.name|key}}. secretEncoding base64 decodes the secret before it is saved.'
const ACTIONS = '1 to 10 actions, each with id, type, enabled, filters (all must match; none means every delivery), template. start_session: agentProvider, modelId, reasoningEffort, cwd, useWorktree. send_to_session: sessionId (a busy session queues it). run_automation: automationId (the template is the run\'s webhook context). call_app: appId (an app\'s id or slug) and operation (a mutation of it), with an empty template; the mutation gets {headers, query, body}. Up to 16 filters: {path, op equals|notEquals|in|exists, value or values}.'
const TEMPLATES = 'Templates and filter paths: {{body.path}}, {{headers.name}}, {{query.name}}, {{body}}, {{request}}; a segment ending in [] tests each list item (body.labels[].name); values compare as text. replay_key is a template: a second delivery with the same key starts nothing.'
const SEE_CREATE = 'See create_webhook for schemes, actions, and templates.'

const CREATE_DESC = `Create a webhook on this host: a secret URL that other services call to start agent work. ${SCHEMES} For a secret, call request_secret first and pass its secretRef as verification.secretRef; never put a secret in the input. ${ACTIONS} ${TEMPLATES} Test with dry_run_webhook before you create it. ${SAFETY} The result gives the URL and its mode; when the host has no URL, ask the user to link the host to Solus Cloud or to set its public URL.`
const UPDATE_DESC = `Change a webhook (any subset). Pause or resume with enabled alone. For a new secret, call request_secret first and pass its secretRef as verification.secretRef; never put a secret in the input. ${SEE_CREATE}`
const DELETE_DESC = 'Delete a webhook, its deliveries log, and its secrets. Its URL stops working.'
const ROTATE_DESC = 'Give a webhook a new URL token. The old URL stops working at once; the sender needs the new URL.'
const LIST_DESC = 'List the webhooks on this host with their id, state, URL mode, actions, and newest delivery. Never the URL token.'
const READ_DELIVERY_DESC = 'Read the deliveries log of a webhook: the newest deliveries, or one delivery with its request (credential-like headers hidden), each action\'s filter results, rendered prompt, status, error, and session.'
const DRY_RUN_DESC = `Test a sample request (method, headers and query as [name, value] pairs, the raw body) against a saved webhook or a list of actions: each filter result and rendered prompt. It starts nothing and stores nothing. ${SEE_CREATE}`

// ─── Helpers ───

function toolActor(): Actor {
  return actorFor(workspaceToolAuthority() ?? INTERNAL_PRINCIPAL)
}

/** Whether the tool's person holds `verb` on the webhook: its owner, or an administrator. One they may not reach answers as one that does not exist. */
async function reachable(id: string, verb: ResourceVerb) {
  const webhook = await loadWebhook(id)
  if (!webhook) return null
  const role = roleOf(toolActor(), { kind: 'webhook', id, ownerKey: webhook.ownerKey, organizationId: webhook.organizationId, acl: [] })
  return standingAllows({ role }, verb) ? webhook : null
}

function notFound(id: string): AgentToolResult {
  return { ok: false, text: `No webhook found with id "${id}".` }
}

function describeUrl(webhook: WebhookWithUrl): string {
  if (webhook.url.mode === 'none') return `This host has no URL for it (path ${webhook.url.path}). Ask the user to link this host to Solus Cloud, or to set its public URL in host settings.`
  return `URL (${webhook.url.mode}): ${webhook.url.url}`
}

function describeWebhook(webhook: Webhook): string {
  const state = webhook.pausedByAdmin ? 'paused by organization admin' : webhook.enabled ? 'active' : 'paused'
  const last = webhook.lastDelivery ? `, last delivery ${new Date(webhook.lastDelivery.at).toISOString()} (${webhook.lastDelivery.outcome})` : ''
  const verification = webhook.verification.scheme === 'none' ? `UNVERIFIED (${webhook.verification.reason})` : webhook.verification.scheme
  return `- ${webhook.id} — "${webhook.name}" (${state}; ${webhook.urlMode} URL; ${verification}; actions: ${webhook.actions.map((action) => `${action.id}:${action.type}`).join(', ')}${last})`
}

function describeResults(results: WebhookActionResult[]): string {
  return results.map((result) => {
    const filters = result.filters.map((entry) => `${entry.matched ? 'pass' : 'FAIL'} ${JSON.stringify(entry.filter)}`).join('; ') || 'no filters'
    const lines = [`Action ${result.actionId} (${result.type}): ${result.status}. Filters: ${filters}.`]
    if (result.missing.length) lines.push(`Missing placeholders: ${result.missing.join(', ')}.`)
    if (result.error) lines.push(`Error: ${result.error}`)
    if (result.sessionId) lines.push(`Session: ${result.sessionId}`)
    if (result.prompt !== undefined) lines.push(`Prompt:\n${result.prompt}`)
    return lines.join('\n')
  }).join('\n\n')
}

type Fields = NonNullable<Parameters<typeof z.object>[0]>

function webhookTool<TFields extends Fields>(name: string, description: string, inputFields: TFields, requiresApproval: boolean, run: (input: z.output<z.ZodObject<TFields>>, context: AgentToolContext) => Promise<AgentToolResult>): AgentTool<TFields> {
  return {
    name,
    description,
    inputFields,
    requiresApproval,
    execute: async (input, context) => {
      try {
        return await run(input, context)
      } catch (err) {
        // A strict contract check names each wrong field, as a schema error would.
        const message = err instanceof z.ZodError ? `Invalid arguments: ${z.prettifyError(err)}` : err instanceof Error ? err.message : String(err)
        log.warn('webhook_tool_failed', { tool: name, sessionId: context.sessionId() ?? null, error: message })
        return { ok: false, text: `${name}: ${message}` }
      }
    },
  }
}

// ─── Tools ───

export const createWebhookAgentTool = webhookTool('create_webhook', CREATE_DESC, createFields, true, async (input, context) => {
  const sessionId = context.sessionId() ?? null
  const organizationId = sessionId ? await organizationOfSession(sessionId) : provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID
  const created = await bound().webhooks.create(webhookCreateInputSchema.parse({
    name: input.name,
    project: input.project ?? context.cwd,
    verification: input.verification,
    actions: input.actions,
    replayKey: input.replay_key ?? null,
    enabled: input.enabled,
  }), await toolAgentAttribution({ sessionId: sessionId ?? undefined, agentProvider: context.provider }), organizationId, sessionId)
  return { ok: true, text: `Created webhook "${created.name}" (id: ${created.id}). ${describeUrl(created)}` }
})

export const updateWebhookAgentTool = webhookTool('update_webhook', UPDATE_DESC, updateFields, true, async (input, context) => {
  if (!(await reachable(input.webhook_id, 'edit'))) return notFound(input.webhook_id)
  const updated = await bound().webhooks.update(input.webhook_id, webhookUpdateInputSchema.parse({
    name: input.name,
    project: input.project,
    verification: input.verification,
    actions: input.actions,
    replayKey: input.replay_key,
    enabled: input.enabled,
  }), context.sessionId() ?? null)
  return updated ? { ok: true, text: `Updated webhook "${updated.name}".` } : notFound(input.webhook_id)
})

export const deleteWebhookAgentTool = webhookTool('delete_webhook', DELETE_DESC, webhookIdField, true, async (input) => {
  if (!(await reachable(input.webhook_id, 'edit'))) return notFound(input.webhook_id)
  return await bound().webhooks.delete(input.webhook_id) ? { ok: true, text: `Deleted webhook ${input.webhook_id}.` } : notFound(input.webhook_id)
})

export const rotateWebhookAgentTool = webhookTool('rotate_webhook', ROTATE_DESC, webhookIdField, true, async (input) => {
  if (!(await reachable(input.webhook_id, 'edit'))) return notFound(input.webhook_id)
  const rotated = await bound().webhooks.rotate(input.webhook_id)
  return rotated ? { ok: true, text: `Rotated the token of "${rotated.name}". The old URL no longer works. ${describeUrl(rotated)}` } : notFound(input.webhook_id)
})

export const listWebhooksAgentTool = webhookTool('list_webhooks', LIST_DESC, {}, false, async () => {
  const visible = await bound().webhooks.list(visibleTo(toolActor(), 'webhook', { id: sql`id`, organization: sql`organization_id`, owner: sql`created_by` }))
  if (!visible.length) return { ok: true, text: 'No webhooks exist on this host yet.' }
  return { ok: true, text: `Webhooks:\n${visible.map(describeWebhook).join('\n')}` }
})

export const readWebhookDeliveryAgentTool = webhookTool('read_webhook_delivery', READ_DELIVERY_DESC, readDeliveryFields, false, async (input) => {
  const webhook = await reachable(input.webhook_id, 'read')
  if (!webhook) return notFound(input.webhook_id)
  if (!input.delivery_id) {
    const deliveries = await listDeliveries(webhook.id, { limit: 20 })
    const lost = webhook.lostCount ? `\n${webhook.lostCount} requests were lost while this host was offline (not verified).` : ''
    if (!deliveries.length) return { ok: true, text: `No deliveries yet.${lost}` }
    return { ok: true, text: `Deliveries (newest first):\n${deliveries.map((delivery) => `- ${delivery.id} — ${new Date(delivery.arrivedAt).toISOString()} ${delivery.source} ${delivery.outcome}${delivery.reason ? ` (${delivery.reason})` : ''}${delivery.replayOf ? ` replay of ${delivery.replayOf}` : ''}`).join('\n')}${lost}` }
  }
  const delivery = await readDelivery(input.delivery_id)
  if (!delivery || delivery.webhookId !== webhook.id) return { ok: false, text: `No delivery "${input.delivery_id}" on webhook "${webhook.id}".` }
  const failure = delivery.verificationFailure ? `\nVerification failed at: ${delivery.verificationFailure.step}${delivery.verificationFailure.detail ? ` (${delivery.verificationFailure.detail})` : ''}` : ''
  return {
    ok: true,
    text: [
      `Delivery ${delivery.id}: ${delivery.outcome}${delivery.reason ? ` — ${delivery.reason}` : ''}. Source ${delivery.source}, received ${new Date(delivery.receivedAt).toISOString()}.${failure}`,
      `Request: ${delivery.request.method}\nHeaders: ${JSON.stringify(delivery.request.headers)}\nQuery: ${JSON.stringify(delivery.request.query)}\nBody${delivery.request.bodyIsBase64 ? ' (base64)' : ''}:\n${delivery.request.body}`,
      describeResults(delivery.actions),
    ].join('\n\n'),
  }
})

export const dryRunWebhookAgentTool = webhookTool('dry_run_webhook', DRY_RUN_DESC, dryRunFields, false, async (input) => {
  const webhook = input.webhook_id ? await reachable(input.webhook_id, 'read') : null
  if (input.webhook_id && !webhook) return notFound(input.webhook_id)
  const actions = input.actions ? z.array(webhookActionSchema).min(1).max(WEBHOOK_MAX_ACTIONS).parse(input.actions) : webhook?.actions
  if (!actions?.length) return { ok: false, text: 'dry_run_webhook needs actions or a webhook_id.' }
  const sample = webhookSampleRequestSchema.parse(input.sample)
  const data = requestData(sample.method, sample.headers, sample.query, Buffer.from(sample.body, 'utf8'))
  let verification = ''
  if (webhook && sample.verify) {
    const result = await verifyRequest(webhook.verification, data, { secret: verificationSecretOf(readWebhookSecrets(webhook.id)), now: Date.now() })
    verification = result.ok ? 'Verification: pass.\n\n' : `Verification: FAIL at ${result.failure.step}${result.failure.detail ? ` (${result.failure.detail})` : ''}.\n\n`
  }
  return { ok: true, text: `${verification}${describeResults(bound().actions.dryRun(actions, data))}` }
})

