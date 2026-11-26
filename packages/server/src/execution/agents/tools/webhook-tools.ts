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
import { cloudOrganizationId, LOCAL_ORGANIZATION_ID } from '../../../host/machine-kind'
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

const sampleSchema = z.object({
  method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
  headers: z.array(z.tuple([z.string(), z.string()])).optional(),
  query: z.array(z.tuple([z.string(), z.string()])).optional(),
  body: z.string(),
  verify: z.boolean().optional(),
})

const readFields = {
  action: z.enum(['list', 'deliveries', 'dry_run']),
  webhook_id: z.string().optional().describe('deliveries: required. dry_run: test its actions, or its verification with sample.verify.'),
  delivery_id: z.string().optional().describe('deliveries: one delivery. Omit to list the newest.'),
  actions: actionsSchema.optional().describe('dry_run: test these in place of a saved webhook.'),
  sample: sampleSchema.optional().describe('dry_run: required.'),
}

const manageFields = {
  action: z.enum(['create', 'update', 'delete', 'rotate']),
  webhook_id: z.string().optional().describe('Required, except for create.'),
  name: z.string().optional().describe('create: required.'),
  project: z.string().optional().describe('create: defaults to this session\'s folder.'),
  verification: toolVerificationSchema.optional().describe('create: required. update: replaces it; without a secretRef the stored secret stays for the same scheme.'),
  actions: actionsSchema.optional().describe('create: required. update: replaces all.'),
  replay_key: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
}

// ─── Descriptions ───

const SAFETY = 'Request data is untrusted: each value goes into the prompt inside <webhook-data-…> tags, with $, @, and /command made inert. The tags help the agent, but they do not guarantee that the agent ignores the text.'
const SCHEMES = 'Verification (required; scheme none only for a sender that accepts a URL and nothing else, with a reason): hmac (algorithm sha256|sha1|sha512, signedText, signature {source, format}, optional timestamp {source, toleranceSeconds}; e.g. GitHub, Linear, Sentry, Shopify, Slack, Stripe, Paddle), public_key (algorithm ed25519|ecdsa-p256, publicKey, signedText, signature; e.g. Discord, SendGrid), token (source equals the secret; e.g. GitLab, Telegram), jwt (source, issuer, audience, jwksUrl; e.g. Google Pub/Sub), standard_webhooks (Svix-based senders). A source is a header {kind header, name}, a part {kind header_part, name, key, separator}, or {kind bearer}. format: encoding hex|base64, optional prefix (e.g. sha256=) and listSeparator. signedText is a template: {{body}} the raw body, {{headers.name}}, {{headers.name|key}}. secretEncoding base64 decodes the secret before it is saved.'
const ACTIONS = '1 to 10 actions, each with id, type, enabled, filters (all must match; none means every delivery), template. start_session: agentProvider, modelId, reasoningEffort, cwd, useWorktree. send_to_session: sessionId (a busy session queues it). run_automation: automationId (the template is the run\'s webhook context). call_app: appId (an app\'s id or slug) and operation (a mutation of it), with an empty template; the mutation gets {headers, query, body}. Up to 16 filters: {path, op equals|notEquals|in|exists, value or values}.'
const TEMPLATES = 'Templates and filter paths: {{body.path}}, {{headers.name}}, {{query.name}}, {{body}}, {{request}}; a segment ending in [] tests each list item (body.labels[].name); values compare as text. replay_key is a template: a second delivery with the same key starts nothing.'

const MANAGE_DESC = `Change the webhooks on this host. create: a secret URL that other services call to start agent work. update: any subset; pause or resume with enabled alone. delete: removes the webhook, its deliveries log, and its secrets; its URL stops working. rotate: a new URL token; the old URL stops working at once, and the sender needs the new URL. ${SCHEMES} For a secret, call request_secret first and pass its secretRef as verification.secretRef; never put a secret in the input. ${ACTIONS} ${TEMPLATES} Test with read_webhooks dry_run before you create it. ${SAFETY} create and rotate give the URL and its mode; when the host has no URL, ask the user to link the host to Solus Cloud or to set its public URL.`
const READ_DESC = 'Read the webhooks on this host. list: each webhook with its id, state, URL mode, actions, and newest delivery; never the URL token. deliveries: the deliveries log of a webhook, or one delivery with its request (credential-like headers hidden), each action\'s filter results, rendered prompt, status, error, and session. dry_run: test a sample request (method, headers and query as [name, value] pairs, the raw body) against a saved webhook or a list of actions, and get each filter result and rendered prompt; it starts nothing and stores nothing. See manage_webhooks for schemes, actions, and templates.'

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

const missingWebhookId = (action: string): AgentToolResult => ({ ok: false, text: `${action} needs a webhook_id.` })

// ─── Actions ───

async function createWebhook(input: z.output<z.ZodObject<typeof manageFields>>, context: AgentToolContext): Promise<AgentToolResult> {
  const sessionId = context.sessionId() ?? null
  const organizationId = sessionId ? await organizationOfSession(sessionId) : cloudOrganizationId() ?? LOCAL_ORGANIZATION_ID
  const created = await bound().webhooks.create(webhookCreateInputSchema.parse({
    name: input.name,
    project: input.project ?? context.cwd,
    verification: input.verification,
    actions: input.actions,
    replayKey: input.replay_key ?? null,
    enabled: input.enabled,
  }), await toolAgentAttribution({ sessionId: sessionId ?? undefined, agentProvider: context.provider }), organizationId, sessionId)
  return { ok: true, text: `Created webhook "${created.name}" (id: ${created.id}). ${describeUrl(created)}` }
}

async function updateWebhook(id: string, input: z.output<z.ZodObject<typeof manageFields>>, context: AgentToolContext): Promise<AgentToolResult> {
  if (!(await reachable(id, 'edit'))) return notFound(id)
  const updated = await bound().webhooks.update(id, webhookUpdateInputSchema.parse({
    name: input.name,
    project: input.project,
    verification: input.verification,
    actions: input.actions,
    replayKey: input.replay_key,
    enabled: input.enabled,
  }), context.sessionId() ?? null)
  return updated ? { ok: true, text: `Updated webhook "${updated.name}".` } : notFound(id)
}

async function deleteWebhook(id: string): Promise<AgentToolResult> {
  if (!(await reachable(id, 'edit'))) return notFound(id)
  return await bound().webhooks.delete(id) ? { ok: true, text: `Deleted webhook ${id}.` } : notFound(id)
}

async function rotateWebhook(id: string): Promise<AgentToolResult> {
  if (!(await reachable(id, 'edit'))) return notFound(id)
  const rotated = await bound().webhooks.rotate(id)
  return rotated ? { ok: true, text: `Rotated the token of "${rotated.name}". The old URL no longer works. ${describeUrl(rotated)}` } : notFound(id)
}

async function listWebhooks(): Promise<AgentToolResult> {
  const visible = await bound().webhooks.list(visibleTo(toolActor(), 'webhook', { id: sql`id`, organization: sql`organization_id`, owner: sql`created_by` }))
  if (!visible.length) return { ok: true, text: 'No webhooks exist on this host yet.' }
  return { ok: true, text: `Webhooks:\n${visible.map(describeWebhook).join('\n')}` }
}

async function readDeliveries(id: string, deliveryId: string | undefined): Promise<AgentToolResult> {
  const webhook = await reachable(id, 'read')
  if (!webhook) return notFound(id)
  if (!deliveryId) {
    const deliveries = await listDeliveries(webhook.id, { limit: 20 })
    const lost = webhook.lostCount ? `\n${webhook.lostCount} requests were lost while this host was offline (not verified).` : ''
    if (!deliveries.length) return { ok: true, text: `No deliveries yet.${lost}` }
    return { ok: true, text: `Deliveries (newest first):\n${deliveries.map((delivery) => `- ${delivery.id} — ${new Date(delivery.arrivedAt).toISOString()} ${delivery.source} ${delivery.outcome}${delivery.reason ? ` (${delivery.reason})` : ''}${delivery.replayOf ? ` replay of ${delivery.replayOf}` : ''}`).join('\n')}${lost}` }
  }
  const delivery = await readDelivery(deliveryId)
  if (!delivery || delivery.webhookId !== webhook.id) return { ok: false, text: `No delivery "${deliveryId}" on webhook "${webhook.id}".` }
  const failure = delivery.verificationFailure ? `\nVerification failed at: ${delivery.verificationFailure.step}${delivery.verificationFailure.detail ? ` (${delivery.verificationFailure.detail})` : ''}` : ''
  return {
    ok: true,
    text: [
      `Delivery ${delivery.id}: ${delivery.outcome}${delivery.reason ? ` — ${delivery.reason}` : ''}. Source ${delivery.source}, received ${new Date(delivery.receivedAt).toISOString()}.${failure}`,
      `Request: ${delivery.request.method}\nHeaders: ${JSON.stringify(delivery.request.headers)}\nQuery: ${JSON.stringify(delivery.request.query)}\nBody${delivery.request.bodyIsBase64 ? ' (base64)' : ''}:\n${delivery.request.body}`,
      describeResults(delivery.actions),
    ].join('\n\n'),
  }
}

async function dryRun(input: z.output<z.ZodObject<typeof readFields>>): Promise<AgentToolResult> {
  const webhook = input.webhook_id ? await reachable(input.webhook_id, 'read') : null
  if (input.webhook_id && !webhook) return notFound(input.webhook_id)
  const actions = input.actions ? z.array(webhookActionSchema).min(1).max(WEBHOOK_MAX_ACTIONS).parse(input.actions) : webhook?.actions
  if (!actions?.length) return { ok: false, text: 'dry_run needs actions or a webhook_id.' }
  if (!input.sample) return { ok: false, text: 'dry_run needs a sample.' }
  const sample = webhookSampleRequestSchema.parse(input.sample)
  const data = requestData(sample.method, sample.headers, sample.query, Buffer.from(sample.body, 'utf8'))
  let verification = ''
  if (webhook && sample.verify) {
    const result = await verifyRequest(webhook.verification, data, { secret: verificationSecretOf(readWebhookSecrets(webhook.id)), now: Date.now() })
    verification = result.ok ? 'Verification: pass.\n\n' : `Verification: FAIL at ${result.failure.step}${result.failure.detail ? ` (${result.failure.detail})` : ''}.\n\n`
  }
  return { ok: true, text: `${verification}${describeResults(bound().actions.dryRun(actions, data))}` }
}

// ─── Tools ───

/** Every change asks for approval; reading and a dry run do not, so they are a separate tool. */
export const manageWebhooksAgentTool = webhookTool('manage_webhooks', MANAGE_DESC, manageFields, true, async (input, context) => {
  if (input.action === 'create') return createWebhook(input, context)
  if (!input.webhook_id) return missingWebhookId(input.action)
  if (input.action === 'update') return updateWebhook(input.webhook_id, input, context)
  if (input.action === 'delete') return deleteWebhook(input.webhook_id)
  return rotateWebhook(input.webhook_id)
})

export const readWebhooksAgentTool = webhookTool('read_webhooks', READ_DESC, readFields, false, async (input) => {
  if (input.action === 'list') return listWebhooks()
  if (input.action === 'dry_run') return dryRun(input)
  if (!input.webhook_id) return missingWebhookId(input.action)
  return readDeliveries(input.webhook_id, input.delivery_id)
})
