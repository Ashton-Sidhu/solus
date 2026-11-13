import { z } from 'zod'
import { MCP_APP_MAX_DATA_BYTES } from './mcp-apps'
import type { Attribution } from './user'
import { webhookVerificationSchema, type WebhookUrlMode } from './webhooks'

/**
 * Apps (docs/plans/apps.md): a record on a host with a repository, versions,
 * its own data, and a backend whose operations four callers use: the app's
 * UI, an agent, a schedule, and a webhook. This module is the contract: the
 * descriptor a build writes, what a client reads of an app, and the names a
 * UI puts on the wire.
 */

// ─── Names ───

export const appSlugSchema = z.string().min(1).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

/** An operation, a schedule, a secret, or a webhook: a name a program can write. */
const declaredNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/)

/** A slug for an app from its name; `app` when the name has no letter or digit. */
export function appSlugOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
  return slug || 'app'
}

const APP_STORAGE_CALL_PREFIX = '@storage/'
const APP_OPERATION_CALL_PREFIX = '@app/'

/** What a UI puts on the wire: `<slug>/<tool>`, `@storage/<operation>`, or `@app/<operation>`. */
export const appCallNameSchema = z.string().min(3).max(512).regex(/^[^/\s]+\/[^\s]+$/)

export const APP_STORAGE_OPERATIONS = ['get', 'set', 'delete', 'keys'] as const
export type AppStorageOperation = (typeof APP_STORAGE_OPERATIONS)[number]

/** What a call name addresses. */
export type AppCallTarget =
  | { kind: 'tool'; slug: string; tool: string }
  | { kind: 'storage'; operation: AppStorageOperation }
  | { kind: 'operation'; name: string }

export function appStorageCallName(operation: AppStorageOperation): string {
  return `${APP_STORAGE_CALL_PREFIX}${operation}`
}

export function appOperationCallName(name: string): string {
  return `${APP_OPERATION_CALL_PREFIX}${name}`
}

/** What a call name addresses, or null when it addresses nothing. */
export function parseAppCallName(name: string): AppCallTarget | null {
  if (name.startsWith(APP_STORAGE_CALL_PREFIX)) {
    const operation = APP_STORAGE_OPERATIONS.find((known) => known === name.slice(APP_STORAGE_CALL_PREFIX.length))
    return operation ? { kind: 'storage', operation } : null
  }
  if (name.startsWith(APP_OPERATION_CALL_PREFIX)) {
    const operation = declaredNameSchema.safeParse(name.slice(APP_OPERATION_CALL_PREFIX.length))
    return operation.success ? { kind: 'operation', name: operation.data } : null
  }
  const at = name.indexOf('/')
  if (name.startsWith('@') || at <= 0 || at === name.length - 1) return null
  return { kind: 'tool', slug: name.slice(0, at), tool: name.slice(at + 1) }
}

// ─── The descriptor (§3): what a build says the backend declares ───

/** A network host an app may reach: `api.example.com`, `*.example.com`, `db.internal:5432`, or `*` for every host. */
const appNetworkHostSchema = z.string().max(256).regex(/^(?:\*|(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)$/i)

/** A host path the backend may use: absolute, under `~`, or `*` for every path. */
const appFilePathSchema = z.string().max(1024).regex(/^(?:\*|~(?:[\\/].*)?|\/.*|[A-Za-z]:[\\/].*)$/)
const appFilePathsSchema = z.array(appFilePathSchema).max(32)

/** What the app may use outside its own data (§6). The runner and the frame enforce it; nobody decides it a second time. */
export const appPermissionsSchema = z.object({
  network: z.array(appNetworkHostSchema).max(32).default([]),
  files: z.object({ read: appFilePathsSchema.default([]), write: appFilePathsSchema.default([]) }).default({ read: [], write: [] }),
})
export type AppPermissions = z.infer<typeof appPermissionsSchema>

/** A JSON Schema, as the build wrote it for an operation's input. */
const appJsonSchemaSchema = z.record(z.string(), z.json())
export type AppJsonSchema = z.infer<typeof appJsonSchemaSchema>

export const appOperationSchema = z.object({
  name: declaredNameSchema,
  /** A query reads and gets a read-only database. A mutation writes. */
  kind: z.enum(['query', 'mutation']),
  description: z.string().max(1000).default(''),
  input: appJsonSchemaSchema,
})
export type AppOperation = z.infer<typeof appOperationSchema>

export const appScheduleTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('interval'), everyMinutes: z.number().int().min(1).max(525_600) }),
  z.object({ type: z.literal('cron'), expr: z.string().min(1).max(120), timezone: z.string().min(1).max(64).optional() }),
])
export type AppScheduleTrigger = z.infer<typeof appScheduleTriggerSchema>

const appInputSchema = z.record(z.string(), z.json())

export const appScheduleDeclarationSchema = z.object({
  name: declaredNameSchema,
  trigger: appScheduleTriggerSchema,
  /** The mutation the schedule runs. */
  run: declaredNameSchema,
  input: appInputSchema.default({}),
})
export type AppScheduleDeclaration = z.infer<typeof appScheduleDeclarationSchema>

export const appSecretDeclarationSchema = z.object({
  name: declaredNameSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
})
export type AppSecretDeclaration = z.infer<typeof appSecretDeclarationSchema>

export const appWebhookDeclarationSchema = z.object({
  name: declaredNameSchema,
  /** How the webhook owner checks a request (docs/plans/webhooks.md §3.7). */
  verify: webhookVerificationSchema,
  /** A template; a second delivery with the same rendered key is a duplicate. */
  replayKey: z.string().min(1).max(200).optional(),
  /** The mutation a delivery runs, with `{ headers, query, body }` as its input. */
  run: declaredNameSchema,
})
export type AppWebhookDeclaration = z.infer<typeof appWebhookDeclarationSchema>

interface Named { name: string }

function repeatedName(entries: readonly Named[]): string | null {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.name)) return entry.name
    seen.add(entry.name)
  }
  return null
}

export const appDescriptorSchema = z.object({
  solusApp: z.literal(2),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  permissions: appPermissionsSchema.default({ network: [], files: { read: [], write: [] } }),
  /** The roles: the integrations the app calls, by slug. */
  integrations: z.array(appSlugSchema).max(64).default([]),
  secrets: z.array(appSecretDeclarationSchema).max(32).default([]),
  operations: z.array(appOperationSchema).max(128).default([]),
  schedules: z.array(appScheduleDeclarationSchema).max(32).default([]),
  webhooks: z.array(appWebhookDeclarationSchema).max(16).default([]),
}).superRefine((descriptor, context) => {
  for (const [field, entries] of [['operations', descriptor.operations], ['schedules', descriptor.schedules], ['secrets', descriptor.secrets], ['webhooks', descriptor.webhooks]] as const) {
    const repeated = repeatedName(entries)
    if (repeated) context.addIssue({ code: 'custom', path: [field], message: `The name ${repeated} is used twice.` })
  }
  const mutations = new Set(descriptor.operations.filter((operation) => operation.kind === 'mutation').map((operation) => operation.name))
  for (const schedule of descriptor.schedules) {
    if (!mutations.has(schedule.run)) context.addIssue({ code: 'custom', path: ['schedules', schedule.name], message: `The schedule ${schedule.name} runs ${schedule.run}, which is not a mutation of this app.` })
  }
  for (const webhook of descriptor.webhooks) {
    if (!mutations.has(webhook.run)) context.addIssue({ code: 'custom', path: ['webhooks', webhook.name], message: `The webhook ${webhook.name} runs ${webhook.run}, which is not a mutation of this app.` })
  }
})
export type AppDescriptor = z.infer<typeof appDescriptorSchema>

function listed(entries: readonly string[], every: string): string {
  return entries.includes('*') ? every : entries.join(', ')
}

/**
 * What an app may use, as one sentence for its header and for the approval of
 * a deploy; null when it has no backend and reaches no network host.
 */
export function describeAppPermissions(permissions: AppPermissions, hasBackend: boolean): string | null {
  const clauses: string[] = []
  if (hasBackend) {
    clauses.push('runs its own code on this host')
    if (permissions.files.read.length > 0) clauses.push(`reads ${listed(permissions.files.read, 'every file')}`)
    if (permissions.files.write.length > 0) clauses.push(`writes ${listed(permissions.files.write, 'every file')}`)
  }
  if (permissions.network.length > 0) clauses.push(`reaches ${listed(permissions.network, 'every network host')}`)
  if (clauses.length === 0) return null
  const sentence = clauses.length <= 2 ? clauses.join(' and ') : `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}`
  return `This app ${sentence}.`
}

// ─── What a client reads ───

export type AppVersionState = 'active' | 'superseded' | 'failed'

/** What needs the owner: a version that failed, a secret that is not set, a schedule whose last run failed, or the app is stopped. */
export interface AppAttention {
  kind: 'version-failed' | 'secret-missing' | 'schedule-failed' | 'stopped'
  /** One sentence for the person. */
  detail: string
}

/** One app, as a list shows it. */
export interface AppSummary {
  id: string
  /** Unique on the host; the namespace an agent's tools and a link use. */
  slug: string
  name: string
  description: string
  organizationId: string
  /** The version that runs; null when no deploy succeeded yet. */
  activeVersion: number | null
  latestVersion: number | null
  stopped: boolean
  hasUi: boolean
  operationCount: number
  /** The folder the app was first deployed from: the project a list groups it under. */
  project: string | null
  createdBy: Attribution
  createdAt: number
  updatedAt: number
  lastCallAt: number | null
  attention: AppAttention[]
}

/** One integration the app names, as the reader has it. */
export interface AppRoleState {
  slug: string
  /** The name of the reader's integration with that slug; null when they have none. */
  name: string | null
  connected: boolean
}

/** One secret the app declares. A client never reads its value. */
export interface AppSecretState {
  name: string
  label: string
  description: string
  isSet: boolean
}

/** What a client needs to show an app: its header, and the policy of its frame. Never the UI itself (`appUi`). */
export interface AppState {
  app: AppSummary
  /** The active version's descriptor; null when no version is active. */
  descriptor: AppDescriptor | null
  roles: AppRoleState[]
  secrets: AppSecretState[]
  /** The network hosts the frame may reach. */
  network: string[]
  /** What the active version may use, in one sentence; null when it uses nothing outside its data. */
  permissionsNotice: string | null
}

/** The UI of the active version: one built HTML file. */
export interface AppUi {
  version: number
  html: string
}

export interface AppVersionView {
  number: number
  state: AppVersionState
  /** Why a failed version did not become active. */
  error: string | null
  message: string
  createdAt: number
  createdBy: Attribution
  permissionsNotice: string | null
  operationCount: number
  hasUi: boolean
}

export interface AppScheduleView {
  name: string
  trigger: AppScheduleTrigger
  run: string
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastOutcome: 'ok' | 'failed' | null
  lastError: string | null
}

/** One webhook the app declares, for its owner: the URL and the secret are credentials. */
export interface AppWebhookView {
  name: string
  run: string
  /** Null while the webhook record could not be made; `problem` says why. */
  webhookId: string | null
  enabled: boolean
  urlMode: WebhookUrlMode
  url: string | null
  /** The signing secret the host made, as text; null for a scheme with no shared secret, or after the owner set another one. */
  secret: string | null
  problem: string | null
}

export const appCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ui') }),
  z.object({ kind: z.literal('agent'), sessionId: z.string().nullable() }),
  z.object({ kind: z.literal('schedule'), name: z.string() }),
  z.object({ kind: z.literal('webhook'), webhookId: z.string() }),
])
export type AppCaller = z.infer<typeof appCallerSchema>

/** One call in the call log. It names the operation and its caller; never the input or the result. */
export interface AppCallView {
  id: string
  version: number
  operation: string
  caller: AppCaller
  startedAt: number
  finishedAt: number | null
  outcome: 'running' | 'ok' | 'failed'
  error: string | null
}

/** A session linked to the app. */
export interface AppSessionLink {
  sessionId: string
  title: string | null
  linkedAt: number
}

/** The source change of one version: a unified patch against the version before it. */
export interface AppVersionDiff {
  version: number
  /** The version the patch is against; null for the first version. */
  base: number | null
  patch: string
  /** True when the patch was cut at the size limit. */
  truncated: boolean
}

export type AppsChangedEvent =
  | { kind: 'saved'; app: AppSummary; /** The session whose deploy made this change, so its conversation can open the app. */ deployedBySessionId?: string }
  | { kind: 'deleted'; appId: string }

// ─── Requests ───

export const appRequestSchema = z.object({ appId: z.string().min(1) })
export type AppRequest = z.infer<typeof appRequestSchema>

export const appCallRequestSchema = appRequestSchema.extend({
  name: appCallNameSchema,
  argumentsJson: z.string().max(MCP_APP_MAX_DATA_BYTES),
})
export type AppCallRequest = z.infer<typeof appCallRequestSchema>

export const appVersionRequestSchema = appRequestSchema.extend({ version: z.number().int().min(1) })
export type AppVersionRequest = z.infer<typeof appVersionRequestSchema>

export const appScheduleRequestSchema = appRequestSchema.extend({ name: declaredNameSchema })
export type AppScheduleRequest = z.infer<typeof appScheduleRequestSchema>

export const appScheduleSetRequestSchema = appScheduleRequestSchema.extend({ enabled: z.boolean() })
export type AppScheduleSetRequest = z.infer<typeof appScheduleSetRequestSchema>

/** `value: null` clears the secret. */
export const appSecretSetRequestSchema = appRequestSchema.extend({ name: declaredNameSchema, value: z.string().min(1).max(8192).nullable() })
export type AppSecretSetRequest = z.infer<typeof appSecretSetRequestSchema>

export const appCallsRequestSchema = appRequestSchema.extend({ limit: z.number().int().min(1).max(500).optional() })
export type AppCallsRequest = z.infer<typeof appCallsRequestSchema>
