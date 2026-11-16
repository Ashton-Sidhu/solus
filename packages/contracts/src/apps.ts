import { z } from 'zod'
import { MCP_APP_MAX_DATA_BYTES } from './mcp-apps'
import type { AgentId, SessionRecordStatus } from './types'
import type { Attribution } from './user'
import { webhookVerificationSchema, type WebhookUrlMode } from './webhooks'

/**
 * Apps (docs/plans/apps.md): a record on a host with a repository, revisions,
 * versions, its own data, and a backend whose operations five callers use:
 * the app's UI, an agent, a schedule, a webhook, and a workflow of the app.
 * This module is the contract: the descriptor a build writes, what a client
 * reads of an app, and the names a UI puts on the wire.
 */

// ─── Names ───

export const appSlugSchema = z.string().min(1).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

/** An operation, a schedule, a secret, a webhook, or a workflow: a name a program can write. */
export const declaredNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/)

/** A signal: lower-case words with dots, such as `report.ready`. */
export const appSignalNameSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/)

/** The protocols this host runs (§6.3): the contract between a build and the runner. The newest is what the skill's template writes. */
export const APP_PROTOCOLS = [2, 3, 4] as const
export type AppProtocol = (typeof APP_PROTOCOLS)[number]
export const APP_PROTOCOL: AppProtocol = 4

/** A slug for an app from its name; `app` when the name has no letter or digit. */
export function appSlugOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
  return slug || 'app'
}

const APP_STORAGE_CALL_PREFIX = '@storage/'
const APP_OPERATION_CALL_PREFIX = '@app/'
const APP_FILES_CALL_PREFIX = '@files/'
const APP_CLIENT_CALL_PREFIX = '@client/'
const APP_CONFIG_CALL_PREFIX = '@config/'
const APP_MODELS_CALL_PREFIX = '@models/'

/** What a UI puts on the wire: `<slug>/<tool>`, `@storage/<operation>`, `@files/<operation>`, `@config/<operation>`, `@models/<operation>`, `@app/<operation>`, or `@client/<operation>`. */
export const appCallNameSchema = z.string().min(3).max(512).regex(/^[^/\s]+\/[^\s]+$/)

export const APP_STORAGE_OPERATIONS = ['get', 'set', 'delete', 'keys'] as const
export type AppStorageOperation = (typeof APP_STORAGE_OPERATIONS)[number]

/** What a UI does with app files (§5). A file crosses in parts, so one call stays under the call limit. */
export const APP_FILE_OPERATIONS = ['begin', 'chunk', 'commit', 'list', 'read', 'remove'] as const
export type AppFileOperation = (typeof APP_FILE_OPERATIONS)[number]

/** What the client that holds the frame answers itself: `save` gives the person a file. These never reach the host. */
export const APP_CLIENT_OPERATIONS = ['save'] as const
export type AppClientOperation = (typeof APP_CLIENT_OPERATIONS)[number]

/** What a UI reads of the app's config: `get`, the values the app runs with. */
export const APP_CONFIG_OPERATIONS = ['get'] as const
export type AppConfigOperation = (typeof APP_CONFIG_OPERATIONS)[number]

/** What a UI does with the app's model calls (docs/plans/app-models.md §5): `get` one with its new text, `cancel` one. */
export const APP_MODEL_OPERATIONS = ['get', 'cancel'] as const
export type AppModelOperation = (typeof APP_MODEL_OPERATIONS)[number]

/** The bytes of one part of a file, before base64. */
export const APP_FILE_CHUNK_BYTES = 384 * 1024
export const APP_FILE_MAX_BYTES = 64 * 1024 * 1024
export const APP_MAX_FILES = 10_000
/** The most bytes `@client/save` gives the person in one file. */
export const APP_CLIENT_SAVE_MAX_BYTES = 16 * 1024 * 1024

/** What a call name addresses. */
export type AppCallTarget =
  | { kind: 'tool'; slug: string; tool: string }
  | { kind: 'storage'; operation: AppStorageOperation }
  | { kind: 'files'; operation: AppFileOperation }
  | { kind: 'client'; operation: AppClientOperation }
  | { kind: 'config'; operation: AppConfigOperation }
  | { kind: 'models'; operation: AppModelOperation }
  | { kind: 'operation'; name: string }

export function appStorageCallName(operation: AppStorageOperation): string {
  return `${APP_STORAGE_CALL_PREFIX}${operation}`
}

export function appOperationCallName(name: string): string {
  return `${APP_OPERATION_CALL_PREFIX}${name}`
}

export function appFileCallName(operation: AppFileOperation): string {
  return `${APP_FILES_CALL_PREFIX}${operation}`
}

export function appClientCallName(operation: AppClientOperation): string {
  return `${APP_CLIENT_CALL_PREFIX}${operation}`
}

export function appConfigCallName(operation: AppConfigOperation): string {
  return `${APP_CONFIG_CALL_PREFIX}${operation}`
}

export function appModelCallName(operation: AppModelOperation): string {
  return `${APP_MODELS_CALL_PREFIX}${operation}`
}

/** What a call name addresses, or null when it addresses nothing. */
export function parseAppCallName(name: string): AppCallTarget | null {
  if (name.startsWith(APP_STORAGE_CALL_PREFIX)) {
    const operation = APP_STORAGE_OPERATIONS.find((known) => known === name.slice(APP_STORAGE_CALL_PREFIX.length))
    return operation ? { kind: 'storage', operation } : null
  }
  if (name.startsWith(APP_FILES_CALL_PREFIX)) {
    const operation = APP_FILE_OPERATIONS.find((known) => known === name.slice(APP_FILES_CALL_PREFIX.length))
    return operation ? { kind: 'files', operation } : null
  }
  if (name.startsWith(APP_CLIENT_CALL_PREFIX)) {
    const operation = APP_CLIENT_OPERATIONS.find((known) => known === name.slice(APP_CLIENT_CALL_PREFIX.length))
    return operation ? { kind: 'client', operation } : null
  }
  if (name.startsWith(APP_CONFIG_CALL_PREFIX)) {
    const operation = APP_CONFIG_OPERATIONS.find((known) => known === name.slice(APP_CONFIG_CALL_PREFIX.length))
    return operation ? { kind: 'config', operation } : null
  }
  if (name.startsWith(APP_MODELS_CALL_PREFIX)) {
    const operation = APP_MODEL_OPERATIONS.find((known) => known === name.slice(APP_MODELS_CALL_PREFIX.length))
    return operation ? { kind: 'models', operation } : null
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

/** A JSON Schema, as the build wrote it for an input, an output, or a payload. */
export const appJsonSchemaSchema = z.record(z.string(), z.json())
export type AppJsonSchema = z.infer<typeof appJsonSchemaSchema>

export const appOperationSchema = z.object({
  name: declaredNameSchema,
  /** A query reads and gets a read-only database. A mutation writes. */
  kind: z.enum(['query', 'mutation']),
  description: z.string().max(1000).default(''),
  input: appJsonSchemaSchema,
  /** What the operation answers. The runner refuses a result it does not accept. */
  output: appJsonSchemaSchema.optional(),
  /** How long one call may take; 60 seconds when absent. */
  timeoutSeconds: z.number().int().min(1).max(900).optional(),
})
export type AppOperation = z.infer<typeof appOperationSchema>

/** A workflow (§8.3): a function the host runs to its end, with durable steps. */
export const appWorkflowDeclarationSchema = z.object({
  name: declaredNameSchema,
  description: z.string().max(1000).default(''),
  input: appJsonSchemaSchema,
})
export type AppWorkflowDeclaration = z.infer<typeof appWorkflowDeclarationSchema>

/** A signal (§8.4): a typed event the app emits. The owner's signal actions decide what one does. */
export const appSignalDeclarationSchema = z.object({
  name: appSignalNameSchema,
  description: z.string().max(1000).default(''),
  payload: appJsonSchemaSchema,
})
export type AppSignalDeclaration = z.infer<typeof appSignalDeclarationSchema>

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

/** One value of an app's config: what the owner sets on the Manage page, and what `ctx.config` and the UI read. */
export type AppConfigValue = string | number | boolean

const configFieldBase = {
  name: declaredNameSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
}

/**
 * One field of an app's config (docs/plans/apps.md §4.4): a setting that is
 * not a secret. The owner changes its value on the Manage page; the backend
 * and the UI read it. The default is the value until the owner sets one.
 */
export const appConfigFieldSchema = z.discriminatedUnion('type', [
  z.object({ ...configFieldBase, type: z.literal('text'), default: z.string().max(2000), multiline: z.boolean().default(false) }),
  z.object({ ...configFieldBase, type: z.literal('number'), default: z.number(), min: z.number().optional(), max: z.number().optional(), integer: z.boolean().default(false) }),
  z.object({ ...configFieldBase, type: z.literal('boolean'), default: z.boolean() }),
  z.object({
    ...configFieldBase,
    type: z.literal('choice'),
    default: z.string().max(200),
    options: z.array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1).max(80) })).min(1).max(50),
  }),
  /** A model id (docs/plans/app-models.md §4); empty is the host's text-generation model. `ctx.models` names the field. */
  z.object({ ...configFieldBase, type: z.literal('model'), default: z.string().max(200).default('') }),
])
export type AppConfigField = z.infer<typeof appConfigFieldSchema>

const configTextSchema = z.string().max(2000)
const configNumberSchema = z.number().finite()

/** Why `value` cannot be the value of `field`, in one sentence; null when it can. */
export function appConfigValueProblem(field: AppConfigField, value: AppConfigValue): string | null {
  switch (field.type) {
    case 'text':
      return configTextSchema.safeParse(value).success ? null : `${field.label} takes text of at most 2000 characters.`
    case 'number': {
      const number = configNumberSchema.safeParse(value)
      if (!number.success) return `${field.label} takes a number.`
      if (field.integer && !Number.isInteger(number.data)) return `${field.label} takes a whole number.`
      if (field.min !== undefined && number.data < field.min) return `${field.label} is at least ${field.min}.`
      if (field.max !== undefined && number.data > field.max) return `${field.label} is at most ${field.max}.`
      return null
    }
    case 'boolean':
      return z.boolean().safeParse(value).success ? null : `${field.label} is on or off.`
    case 'choice':
      return field.options.some((option) => option.value === value) ? null : `${field.label} takes one of ${field.options.map((option) => option.label).join(', ')}.`
    case 'model':
      return z.string().max(200).safeParse(value).success ? null : `${field.label} takes a model id.`
  }
}

/** The config the app runs with: each field's stored value when it is still a value of the field, else its default. */
export function resolveAppConfig(fields: readonly AppConfigField[], stored: { readonly [name: string]: AppConfigValue }): { [name: string]: AppConfigValue } {
  return Object.fromEntries(fields.map((field) => {
    const value = stored[field.name]
    return [field.name, value !== undefined && appConfigValueProblem(field, value) === null ? value : field.default]
  }))
}

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
  /** The build's protocol (§6.3). */
  solusApp: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  /** What the app tells the agents that use it. */
  instructions: z.string().max(8000).default(''),
  permissions: appPermissionsSchema.default({ network: [], files: { read: [], write: [] } }),
  /** The roles: the integrations the app calls, by slug. Each one is a user connection (the caller's own) unless `appIntegrations` names it. */
  integrations: z.array(appSlugSchema).max(64).default([]),
  /** The roles that are app connections (docs/plans/app-deploy.md §6): the owner links one for everyone, and each caller and the background work of the app use it. Protocol 4. */
  appIntegrations: z.array(appSlugSchema).max(64).default([]),
  secrets: z.array(appSecretDeclarationSchema).max(32).default([]),
  config: z.array(appConfigFieldSchema).max(32).default([]),
  operations: z.array(appOperationSchema).max(128).default([]),
  schedules: z.array(appScheduleDeclarationSchema).max(32).default([]),
  webhooks: z.array(appWebhookDeclarationSchema).max(16).default([]),
  workflows: z.array(appWorkflowDeclarationSchema).max(32).default([]),
  signals: z.array(appSignalDeclarationSchema).max(32).default([]),
}).superRefine((descriptor, context) => {
  for (const [field, entries] of [['operations', descriptor.operations], ['schedules', descriptor.schedules], ['secrets', descriptor.secrets], ['config', descriptor.config], ['webhooks', descriptor.webhooks], ['workflows', descriptor.workflows], ['signals', descriptor.signals]] as const) {
    const repeated = repeatedName(entries)
    if (repeated) context.addIssue({ code: 'custom', path: [field], message: `The name ${repeated} is used twice.` })
  }
  // A role has one scope: each app connection is one of the roles, and no role is named twice (docs/plans/app-deploy.md §6).
  const roles = new Set(descriptor.integrations)
  if (roles.size !== descriptor.integrations.length) context.addIssue({ code: 'custom', path: ['integrations'], message: 'An integration is named twice. A name is used one time across `integrations` and `appIntegrations`.' })
  const strayRole = descriptor.appIntegrations.find((slug) => !roles.has(slug))
  if (strayRole) context.addIssue({ code: 'custom', path: ['appIntegrations'], message: `The app connection ${strayRole} is not one of the app's integrations.` })
  for (const field of descriptor.config) {
    const problem = appConfigValueProblem(field, field.default)
    if (problem) context.addIssue({ code: 'custom', path: ['config', field.name], message: `The default of ${field.name} is not one of its values: ${problem}` })
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

/** `building`: the host builds the revision now. `failed`: the build or the start failed, and the version before it still runs. */
export type AppVersionState = 'building' | 'active' | 'superseded' | 'failed'

/**
 * What needs the owner: a version that failed, a secret that is not set, a
 * schedule or a workflow whose last run failed on the active version, or the
 * app is stopped. `workflow-stale`: the last run of a workflow failed on an
 * older version, and the active version has not run it again.
 */
export interface AppAttention {
  kind: 'version-failed' | 'secret-missing' | 'schedule-failed' | 'workflow-failed' | 'workflow-stale' | 'stopped'
  /** One sentence for the person. */
  detail: string
  /** `workflow-failed` and `workflow-stale`: the run that failed, which Retry starts again and Dismiss takes off this list. */
  runId?: string
}

/** One app, as a list shows it. */
export interface AppSummary {
  id: string
  /** Unique on the host; the namespace an agent's tools and a link use. */
  slug: string
  /** The name and description people see: the owner's when they gave one, else the manifest's. */
  name: string
  description: string
  /** The active version's manifest name and description, which a rename or a reset goes back to. */
  manifestName: string
  manifestDescription: string
  /** The hue (0–359) the owner chose for the app's tile; null takes one from the app's id. */
  colorHue: number | null
  organizationId: string
  /** The version that runs; null when no deploy succeeded yet. */
  activeVersion: number | null
  latestVersion: number | null
  /** The newest revision; null for an app with no save, which cannot be. */
  latestRevision: string | null
  /** The newest revision has no version that was built from it: a save waits for a deploy. */
  hasUndeployedRevision: boolean
  /** The version the host builds now; null when no build is in progress. */
  buildingVersion: number | null
  stopped: boolean
  /** The app's operations are tools for agents. */
  agentAccess: boolean
  hasUi: boolean
  operationCount: number
  /** The folder the app was first saved from: the project a list groups it under. */
  project: string | null
  createdBy: Attribution
  createdAt: number
  updatedAt: number
  lastCallAt: number | null
  /** The calls of the last 24 hours, and how many of them failed. */
  calls24h: number
  failed24h: number
  attention: AppAttention[]
}

/** One integration the app names, as the reader has it. */
export interface AppRoleState {
  slug: string
  /** `app`: the owner's connection, for each caller. `user`: the caller's own. */
  scope: 'app' | 'user'
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

/** One field of the app's config, with the value the app runs with. */
export type AppConfigState = AppConfigField & {
  value: AppConfigValue
  /** The value is the field's default: the owner set none, or set the default. */
  isDefault: boolean
}

/** The runner of one app, now. */
export interface AppRuntimeView {
  /** The app's backend has a process now. A runner stops when it is idle and starts for the next call. */
  running: boolean
  startedAt: number | null
  /** The calls and the runs in progress. */
  inFlight: number
  /** The memory of the process at its last answer; null until it answered once. */
  rssBytes: number | null
}

/** What a client needs to show an app: its header, and the policy of its frame. Never the UI itself (`appUi`). */
export interface AppState {
  app: AppSummary
  /** The active version's descriptor; null when no version is active. */
  descriptor: AppDescriptor | null
  roles: AppRoleState[]
  secrets: AppSecretState[]
  config: AppConfigState[]
  /** The network hosts the frame may reach. */
  network: string[]
  /** What the active version may use, in one sentence; null when it uses nothing outside its data. */
  permissionsNotice: string | null
  runtime: AppRuntimeView
  /** Where the app's git repository is on its host: what its owner clones. */
  repositoryPath: string
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
  /** The revision the version was built from. */
  revision: string
  protocol: number
  /** How long the build took; null while it builds and for a version from before the host built. */
  buildMs: number | null
  /** Each time this version became active, the oldest first. The first one is its deploy; a later one is a rollback or a roll forward. */
  activations: AppVersionActivation[]
}

/** One time a version became active: when, who made it active, and the version that ran before it. */
export interface AppVersionActivation {
  at: number
  by: Attribution
  /** The version that was active before; null when no version ran. */
  previous: number | null
}

/** How much one save changed: the files, and the lines added and removed. */
export interface AppRevisionStats {
  files: number
  additions: number
  deletions: number
}

/** One revision: one save of the app's source. */
export interface AppRevisionView {
  commit: string
  message: string
  savedAt: number
  /** The versions that were built from it; empty for a save that waits for a deploy. */
  versions: number[]
  stats: AppRevisionStats
}

/** The text of one version's build. */
export interface AppBuildLog {
  version: number
  log: string
  buildMs: number | null
}

/** What a deploy answers. */
export interface AppDeployReceipt {
  app: AppSummary
  version: number
  /** False when the build or the start failed: the version before it still runs. */
  active: boolean
  error: string | null
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

/**
 * The calendar of an app's schedules (§9.2): for each schedule, its runs in
 * each span of time the client asked for. A client gives the edges of the
 * spans, so a day and an hour are the client's own, in its time zone.
 */
export interface AppScheduleCalendar {
  /** The edges that were asked for: span `i` is from `edges[i]` to `edges[i + 1]`. */
  edges: number[]
  /** The call log keeps the newest calls of an app only: a span before this time can show fewer runs than ran. Null when the log keeps every call. */
  keptSince: number | null
  lanes: AppScheduleLane[]
}

/** One schedule in the calendar: one cell for each span, and the runs to come. */
export interface AppScheduleLane {
  name: string
  spans: AppScheduleSpan[]
  /** The next runs, at most five; empty when the schedule is paused. */
  upcoming: number[]
}

/** The runs of one schedule in one span. `planned` is how many runs the trigger gives in the span, at most 1,000. */
export interface AppScheduleSpan {
  ok: number
  failed: number
  running: number
  planned: number
  /** When the newest run in the span started, and how it ended; null for a span with no run. */
  lastRunAt: number | null
  lastOutcome: AppCallOutcome | null
}

/** What a list of declared names gains and loses from one version to another. */
export interface AppNameChanges {
  added: string[]
  removed: string[]
}

/**
 * What a deploy of a revision changes against the active version (§9.2),
 * read on the host before the owner deploys. The host builds the revision to
 * read what it declares, and does not make a version of it.
 */
export interface AppDeployPreflight {
  commit: string
  /** The version the revision is compared with; null when no version is active. */
  against: number | null
  /** The build of the revision failed: a deploy of it fails too. The other fields are then empty. */
  buildError: string | null
  network: AppNameChanges
  /** The host paths the backend may read and write. */
  readPaths: AppNameChanges
  writePaths: AppNameChanges
  /** The config fields of the kind `model`: the model settings of the app. */
  models: AppNameChanges
  integrations: AppNameChanges
  operations: AppNameChanges
  workflows: AppNameChanges
  schedules: AppNameChanges
  webhooks: AppNameChanges
  signals: AppNameChanges
  /** The secrets the revision declares that have no value on the host. */
  secretsMissing: { name: string; label: string }[]
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

/** What a person may do in an app: the owner manages it, an editor runs its queries and mutations, a viewer its queries (docs/plans/app-deploy.md §7). */
export const appCallerRoleSchema = z.enum(['owner', 'editor', 'viewer'])
export type AppCallerRole = z.infer<typeof appCallerRoleSchema>

/** The person of a call from the app's UI, as the app's code reads it in `ctx.caller`. Absent for a guest and for a visitor of a public app. */
export const appCallerUserSchema = z.object({ id: z.string().min(1), name: z.string() })
export type AppCallerUser = z.infer<typeof appCallerUserSchema>

export const appCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ui'), user: appCallerUserSchema.optional(), role: appCallerRoleSchema.optional() }),
  z.object({ kind: z.literal('agent'), sessionId: z.string().nullable() }),
  z.object({ kind: z.literal('schedule'), name: z.string() }),
  z.object({ kind: z.literal('webhook'), webhookId: z.string() }),
  z.object({ kind: z.literal('workflow'), runId: z.string(), workflow: z.string(), step: z.string() }),
  /** An operation a model call used as a tool (docs/plans/app-models.md). */
  z.object({ kind: z.literal('model'), callId: z.string() }),
])
export type AppCaller = z.infer<typeof appCallerSchema>
export type AppCallerKind = AppCaller['kind']
export const APP_CALLER_KINDS = ['ui', 'agent', 'schedule', 'webhook', 'workflow', 'model'] as const satisfies readonly AppCallerKind[]

export type AppCallOutcome = 'running' | 'ok' | 'failed'

/** What a row of the call log is: a call of an operation, or a model call (docs/plans/app-models.md). */
export type AppCallKind = 'operation' | 'model'

/**
 * One row of the call log, as a list shows it: one call of an operation, or
 * one execution of a workflow's function. The second has the caller
 * `workflow` with an empty `step`, and its `operation` is the workflow's
 * name: its log lines and the spans of its steps are in it.
 */
export interface AppCallView {
  /** For a model call, the id of its model call record. */
  id: string
  version: number
  kind: AppCallKind
  /** The operation, or for a model call the model setting it used. */
  operation: string
  caller: AppCaller
  startedAt: number
  finishedAt: number | null
  outcome: AppCallOutcome
  error: string | null
  durationMs: number | null
  logCount: number
  spanCount: number
  /**
   * The W3C trace id and span id of the call's OpenTelemetry span: what finds
   * the call in a collector and in Insights. Null for a call from a host with
   * no tracer.
   */
  traceId: string | null
  spanId: string | null
}

export const appLogLineSchema = z.object({
  /** Milliseconds from the start of the call. */
  atMs: z.number(),
  level: z.enum(['debug', 'log', 'info', 'warn', 'error']),
  text: z.string(),
})
export type AppLogLine = z.infer<typeof appLogLineSchema>

/** One span of a call's trace (§1): something the call waited for. */
export const appSpanSchema = z.object({
  /** `sql` is one span for the whole call: its statements and their total time. */
  kind: z.enum(['fetch', 'tool', 'sql', 'file', 'signal', 'workflow', 'step', 'model']),
  /** What it was: `GET api.example.com`, `linear.list_issues`, `12 statements`. */
  name: z.string(),
  /** Milliseconds from the start of the call. */
  startMs: z.number(),
  durationMs: z.number(),
  ok: z.boolean(),
  /** A status, a count, or the reason it failed. */
  detail: z.string().optional(),
  /**
   * What the span says of itself, with OpenTelemetry's names where it has a
   * convention: `http.request.method` and `server.address` for a request,
   * `db.system.name` for the SQL. The host's tracer sends them as they are.
   */
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})
export type AppSpan = z.infer<typeof appSpanSchema>

/** One call with what the host kept of it (decision 21). Never a result, never a secret. */
export interface AppCallDetail extends AppCallView {
  /** The input as JSON text; null for a call from before the host kept inputs. */
  input: string | null
  /** The input was longer than the host keeps, and `input` is its start. */
  inputTruncated: boolean
  resultBytes: number | null
  errorStack: string | null
  logs: AppLogLine[]
  /** The call wrote more lines than the host keeps. */
  logsTruncated: boolean
  spans: AppSpan[]
  /** The run a step's call belongs to. */
  runId: string | null
}

export interface AppOperationMetrics {
  operation: string
  calls: number
  failed: number
  p50Ms: number | null
  p95Ms: number | null
  lastAt: number | null
}

/** The calls of the last 24 hours (§9.2). */
export interface AppMetrics {
  since: number
  calls: number
  failed: number
  p50Ms: number | null
  p95Ms: number | null
  /** One entry for each of the 24 hours, the oldest first. */
  hours: { start: number; calls: number; failed: number }[]
  /** The operations that were called, the most calls first. */
  operations: AppOperationMetrics[]
}

/**
 * The calls that pass the filters of a read, in numbers (§9.2): the Activity
 * chart. The time from `since` to `until` is cut into buckets of `bucketMs`,
 * the oldest first; the last one ends at `until`.
 */
export interface AppCallStats {
  since: number
  until: number
  bucketMs: number
  calls: number
  failed: number
  p50Ms: number | null
  p95Ms: number | null
  buckets: { start: number; calls: number; failed: number }[]
}

// ─── App files (§4.3) ───

/** One app file. Its bytes cross through `@files/read`. */
export interface AppFileView {
  id: string
  name: string
  /** The media type; `application/octet-stream` when nothing said. */
  type: string
  size: number
  createdAt: number
  /** Who made it: a person in a UI, or the backend for one of its callers. */
  createdBy: AppCallerKind
}

// ─── Workflows (§8.3) ───

export type AppRunState = 'running' | 'sleeping' | 'succeeded' | 'failed' | 'terminated'
export const APP_RUN_STATES = ['running', 'sleeping', 'succeeded', 'failed', 'terminated'] as const satisfies readonly AppRunState[]

export interface AppRunView {
  id: string
  workflow: string
  state: AppRunState
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  /** When a sleeping run starts again. */
  wakeAt: number | null
  error: string | null
  startedBy: AppCaller
  stepCount: number
  /** The version whose code ran the run last; null for a run no runner took, or one from before the host kept it. */
  version: number | null
  /** When the owner dismissed the failure of the run; it stays in the history. */
  dismissedAt: number | null
}

export type AppStepKind = 'do' | 'sleep' | 'query' | 'mutation' | 'model'
export type AppStepState = 'running' | 'done' | 'failed' | 'sleeping'

export interface AppStepView {
  name: string
  kind: AppStepKind
  state: AppStepState
  attempts: number
  startedAt: number
  finishedAt: number | null
  wakeAt: number | null
  error: string | null
  /** The start of the step's result as JSON text. */
  result: string | null
  resultTruncated: boolean
  /**
   * Each try of a `step.do` step that the run's log keeps, the oldest first.
   * Empty for another kind of step. Absent from a host older than this field.
   */
  tries?: AppStepTry[]
  /** How the step tries again, as its newest try said; null when no try said it. Absent from a host older than this field. */
  retryPolicy?: AppStepRetryPolicy | null
}

/** One try of a `step.do` step: the span the runner wrote for it. */
export interface AppStepTry {
  attempt: number
  startedAt: number
  durationMs: number
  ok: boolean
  /** Why the try failed; null for a try that ended well. */
  error: string | null
}

/** The retry options of a `step.do` step (§8.3). */
export interface AppStepRetryPolicy {
  /** How many times the step tries again after its first try. */
  limit: number
  delayMs: number
  backoff: 'constant' | 'linear' | 'exponential'
  timeoutMs: number
}

export interface AppRunDetail extends AppRunView {
  /** The run's input as JSON text. */
  input: string
  result: string | null
  /** The key the run was started with: a second start with it gives this run. */
  key: string | null
  steps: AppStepView[]
}

// ─── Signals (§8.4) ───

const signalTemplateSchema = z.string().max(8000).default('')

/**
 * What the owner made a signal do. A template takes `{{payload.path}}`,
 * `{{payload}}`, `{{signal}}`, and `{{app}}`; an empty one gives the signal
 * and its payload. A signal that must start a new session runs an automation:
 * the automation holds the agent, the model, and the folder.
 */
export const appSignalActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notify'), title: z.string().max(300).default(''), detail: z.string().max(500).default('') }),
  z.object({ type: z.literal('send_to_session'), template: signalTemplateSchema, sessionId: z.string().min(1) }),
  z.object({ type: z.literal('run_automation'), template: signalTemplateSchema, automationId: z.string().min(1) }),
])
export type AppSignalAction = z.infer<typeof appSignalActionSchema>
export type AppSignalActionType = AppSignalAction['type']

export interface AppSignalActionView {
  id: string
  signal: string
  enabled: boolean
  action: AppSignalAction
  /** How many occurrences of the last 7 days this action delivered, and how many it did not (failed or over the limit). */
  delivered7d: number
  failed7d: number
}

/** What emitted the newest occurrence of a signal: an operation, or a step of a workflow. */
export interface AppSignalEmitter {
  kind: 'operation' | 'workflow'
  name: string
}

/** One signal the active version declares, with what the owner made it do. */
export interface AppSignalView {
  name: string
  description: string
  payload: AppJsonSchema
  actions: AppSignalActionView[]
  lastEmittedAt: number | null
  count24h: number
  count7d: number
  /** Null when the signal has no occurrence, or its source is gone. */
  emittedBy: AppSignalEmitter | null
}

/** How one signal action ended for one occurrence. `throttled`: the action reached its limit of agent starts for the hour (decision 24). */
export const appSignalDeliverySchema = z.object({
  actionId: z.string(),
  type: z.enum(['notify', 'send_to_session', 'run_automation']),
  status: z.enum(['delivered', 'failed', 'throttled']),
  detail: z.string().nullable(),
  /** The session the action sent the prompt to. */
  sessionId: z.string().optional(),
})
export type AppSignalDelivery = z.infer<typeof appSignalDeliverySchema>

export interface AppSignalOccurrence {
  id: string
  name: string
  /** The payload as JSON text. */
  payload: string
  emittedAt: number
  callId: string | null
  runId: string | null
  deliveries: AppSignalDelivery[]
}

/** One occurrence of a signal as it happens, for the live tail of the Signals section: once when the app emits it, and again when its actions end. */
export interface AppSignalOccurredEvent {
  appId: string
  occurrence: AppSignalOccurrence
}

/** A session linked to the app. The record fields are null when the host keeps no record of the session. */
export interface AppSessionLink {
  sessionId: string
  title: string | null
  linkedAt: number
  provider: AgentId | null
  status: SessionRecordStatus | null
  lastActivityAt: number | null
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

/** The source change of one revision: a unified patch against the revision before it. */
export interface AppRevisionDiff {
  commit: string
  /** The revision the patch is against; null for the first one. */
  base: string | null
  patch: string
  truncated: boolean
}

/**
 * Where one step of a workflow is in the source of a version (§9.2): the file
 * and the place of its `step.do('<name>'` call, and the text of that file for
 * a read-only view. Line and column start at 1.
 */
export interface AppStepSource {
  version: number
  path: string
  line: number
  column: number
  text: string
}

export type AppsChangedEvent =
  | { kind: 'saved'; app: AppSummary; /** The session whose deploy made this change, so its conversation can open the app. */ deployedBySessionId?: string }
  | { kind: 'deleted'; appId: string }

/** What of an app's activity changed, so a Manage page reads its open section again. */
export const APP_ACTIVITY_KINDS = ['calls', 'runs', 'signals', 'files', 'models', 'deployment'] as const
export type AppActivityKind = (typeof APP_ACTIVITY_KINDS)[number]
export interface AppActivityEvent {
  appId: string
  kinds: AppActivityKind[]
}

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

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)

export const appRevisionRequestSchema = appRequestSchema.extend({
  commit: commitSchema,
  /** The revision the patch is against; the revision before `commit` when absent. A rollback compares the two revisions it moved between. */
  against: commitSchema.optional(),
})
export type AppRevisionRequest = z.infer<typeof appRevisionRequestSchema>

/** `version` absent: the active version. */
export const appStepSourceRequestSchema = appRequestSchema.extend({
  workflow: declaredNameSchema,
  step: z.string().min(1).max(200),
  version: z.number().int().min(1).optional(),
})
export type AppStepSourceRequest = z.infer<typeof appStepSourceRequestSchema>

/** `commit` absent: the newest revision. */
export const appDeployRequestSchema = appRequestSchema.extend({ commit: commitSchema.optional() })
export type AppDeployRequest = z.infer<typeof appDeployRequestSchema>

/** What a deploy of `commit` would change against the active version. */
export const appDeployPreflightRequestSchema = appRequestSchema.extend({ commit: commitSchema })
export type AppDeployPreflightRequest = z.infer<typeof appDeployPreflightRequestSchema>

export const appAgentAccessRequestSchema = appRequestSchema.extend({ enabled: z.boolean() })
export type AppAgentAccessRequest = z.infer<typeof appAgentAccessRequestSchema>

/** What the owner calls the app and the colour of its tile. A field left out stays; null goes back to the manifest's text or the colour from the app's id. */
export const appUpdateSchema = z.object({
  name: z.string().max(80).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  colorHue: z.number().int().min(0).max(359).nullable().optional(),
}).strict()
export type AppUpdate = z.infer<typeof appUpdateSchema>
export const appUpdateRequestSchema = appRequestSchema.extend({ patch: appUpdateSchema })
export type AppUpdateRequest = z.infer<typeof appUpdateRequestSchema>

export const appScheduleRequestSchema = appRequestSchema.extend({ name: declaredNameSchema })
export type AppScheduleRequest = z.infer<typeof appScheduleRequestSchema>

export const appScheduleSetRequestSchema = appScheduleRequestSchema.extend({ enabled: z.boolean() })
export type AppScheduleSetRequest = z.infer<typeof appScheduleSetRequestSchema>

/** The longest calendar a client reads at one time: five weeks. */
export const APP_SCHEDULE_CALENDAR_MAX_MS = 35 * 24 * 60 * 60_000

/** The edges of the calendar's spans, ascending: two edges give one span. */
export const appScheduleCalendarRequestSchema = appRequestSchema.extend({
  edges: z.array(z.number().int().min(0)).min(2).max(49),
}).refine(({ edges }) => edges.every((edge, index) => index === 0 || edge > edges[index - 1]), { message: 'The edges of the calendar go up.' })
  .refine(({ edges }) => edges[edges.length - 1] - edges[0] <= APP_SCHEDULE_CALENDAR_MAX_MS, { message: 'A calendar is at most five weeks long.' })
export type AppScheduleCalendarRequest = z.infer<typeof appScheduleCalendarRequestSchema>

/** `value: null` clears the secret. */
export const appSecretSetRequestSchema = appRequestSchema.extend({ name: declaredNameSchema, value: z.string().min(1).max(8192).nullable() })
export type AppSecretSetRequest = z.infer<typeof appSecretSetRequestSchema>

/** `value: null` gives the field its default again. */
export const appConfigSetRequestSchema = appRequestSchema.extend({ name: declaredNameSchema, value: z.union([z.string().max(2000), z.number(), z.boolean()]).nullable() })
export type AppConfigSetRequest = z.infer<typeof appConfigSetRequestSchema>

/**
 * The fields a term of a call log query names (§9.2). `caller` is the kind of
 * caller, `run` the id of a workflow run, `error` text in the error, and
 * `text` text the call holds anywhere, as `search` finds it.
 */
export const APP_CALL_QUERY_FIELDS = ['operation', 'caller', 'outcome', 'version', 'run', 'error', 'text'] as const
export type AppCallQueryField = (typeof APP_CALL_QUERY_FIELDS)[number]
export const appCallTermSchema = z.object({ field: z.enum(APP_CALL_QUERY_FIELDS), value: z.string().trim().min(1).max(200) })
export type AppCallTerm = z.infer<typeof appCallTermSchema>

/** The filters of the call log. Its rows and its numbers take the same ones. */
const appCallFilterFields = {
  operation: z.string().min(1).max(64).optional(),
  outcome: z.enum(['running', 'ok', 'failed']).optional(),
  callerKind: z.enum(APP_CALLER_KINDS).optional(),
  runId: z.string().min(1).optional(),
  /** Text the call holds, in any case: in its operation, its caller, its error, its input, or a log line. */
  search: z.string().trim().min(1).max(200).optional(),
  /** Only the calls of operations, or only the model calls. */
  kind: z.enum(['operation', 'model']).optional(),
  /** Only calls that started at this time or later. */
  since: z.number().optional(),
  /** Only calls that started before this time: the end of a time range the Activity chart zooms to. */
  until: z.number().optional(),
  /** A query: every group must match, and a group matches when one of its terms does. */
  match: z.array(z.array(appCallTermSchema).min(1).max(16)).max(16).optional(),
}

/** The newest calls that pass every filter given. `before` is the `startedAt` of the last row of the page before. */
export const appCallsRequestSchema = appRequestSchema.extend({
  limit: z.number().int().min(1).max(500).optional(),
  ...appCallFilterFields,
  before: z.number().optional(),
})
export type AppCallsRequest = z.infer<typeof appCallsRequestSchema>

/** The numbers of every call that passes the filters, not only of a page of rows. */
export const appCallStatsRequestSchema = appRequestSchema.extend(appCallFilterFields)
export type AppCallStatsRequest = z.infer<typeof appCallStatsRequestSchema>

export const appCallReadRequestSchema = appRequestSchema.extend({ callId: z.string().min(1) })
export type AppCallReadRequest = z.infer<typeof appCallReadRequestSchema>

export const appRunsRequestSchema = appRequestSchema.extend({
  state: z.enum(APP_RUN_STATES).optional(),
  limit: z.number().int().min(1).max(200).optional(),
})
export type AppRunsRequest = z.infer<typeof appRunsRequestSchema>

export const appRunRequestSchema = appRequestSchema.extend({ runId: z.string().min(1) })
export type AppRunRequest = z.infer<typeof appRunRequestSchema>

export const appSignalOccurrencesRequestSchema = appRequestSchema.extend({
  signal: appSignalNameSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
})
export type AppSignalOccurrencesRequest = z.infer<typeof appSignalOccurrencesRequestSchema>

/** `actionId` absent: a new signal action. */
export const appSignalActionSaveRequestSchema = appRequestSchema.extend({
  actionId: z.string().min(1).optional(),
  signal: appSignalNameSchema,
  enabled: z.boolean(),
  action: appSignalActionSchema,
})
export type AppSignalActionSaveRequest = z.infer<typeof appSignalActionSaveRequestSchema>

export const appSignalActionRequestSchema = appRequestSchema.extend({ actionId: z.string().min(1) })
export type AppSignalActionRequest = z.infer<typeof appSignalActionRequestSchema>

/** One webhook the app declares, by its declared name. */
export const appWebhookRequestSchema = appRequestSchema.extend({ name: declaredNameSchema })
export type AppWebhookRequest = z.infer<typeof appWebhookRequestSchema>

export const appFileRequestSchema = appRequestSchema.extend({ fileId: z.string().min(1) })
export type AppFileRequest = z.infer<typeof appFileRequestSchema>

/** One session of the app's linked sessions. */
export const appSessionRequestSchema = appRequestSchema.extend({ sessionId: z.string().min(1) })
export type AppSessionRequest = z.infer<typeof appSessionRequestSchema>
