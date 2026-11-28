// `@solus/app/backend`: what an app's backend is written with. A project is
// an app when it has an `app.ts` next to `package.json` that exports
// `defineApp({ ... })` as its default (see the create-app skill).
//
// Do not edit. The build bundles this file into the backend, and Solus reads
// what `descriptor()` answers. This file is protocol 4: it says what `ctx`
// holds for the app. Solus runs an app with the protocol of the file it was
// built with, so an older project keeps working until this file is replaced.

import { z } from 'zod'

/** A JSON value: all an operation takes and answers. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** A value SQLite binds and returns. */
export type SqlValue = string | number | bigint | null | Uint8Array

export interface SqlRows<Row> {
  /** Every row the statement returned; empty for a statement that returns none. */
  all(): Row[]
  /** The first row, or null. */
  one(): Row | null
  /** How many rows the statement inserted, updated, or deleted; 0 for a SELECT. */
  readonly rowsWritten: number
}

/** The app's own SQLite database. The schema comes from `migrations/`. */
export interface Sql {
  /** Runs one statement now, with `?` values. It commits by itself unless a transaction is open. */
  exec<Row = { [column: string]: SqlValue }>(text: string, ...values: SqlValue[]): SqlRows<Row>
  /** Groups statements: all of them commit, or none. `run` is synchronous: do network work before or after it. */
  transaction<T>(run: () => T): T
}

/**
 * Who started the call. A call from the app's UI names its person and what
 * they may do: the owner, an editor (queries and mutations), or a viewer
 * (queries). `user` is absent for a visitor who did not sign in to Solus: a
 * guest with a link, or anyone when the app is public. Check `role` before an
 * operation that only the owner may run.
 */
export type Caller =
  | { kind: 'ui'; user?: { id: string; name: string }; role?: 'owner' | 'editor' | 'viewer' }
  | { kind: 'agent'; sessionId: string | null }
  | { kind: 'schedule'; name: string }
  | { kind: 'webhook'; webhookId: string }
  | { kind: 'workflow'; runId: string; workflow: string; step: string }

/** One tool of an integration: `ctx.tools.linear.list_issues({ team })`. `T` is the type you expect back. */
export type IntegrationTool = <T = Json>(input?: object) => Promise<T>

/** One app file: a file the app holds, with a record. The person uploads one in the UI, or the backend writes one. */
export interface AppFile {
  id: string
  name: string
  /** The media type. */
  type: string
  size: number
  createdAt: number
}

/** The app files. A query reads; a mutation and a workflow step also write and remove. */
export interface Files {
  /** The path of a folder that is the app's own, with no records: always readable and writable. */
  dir: string
  list(): Promise<AppFile[]>
  get(id: string): Promise<AppFile | null>
  /** Where the bytes of a file are on the host, for a library that takes a path. */
  path(id: string): string
  read(id: string): Promise<Uint8Array>
  text(id: string): Promise<string>
  /** Keeps a new file. The UI can then show it, and the person can save it. */
  write(name: string, data: string | Uint8Array, type?: string): Promise<AppFile>
  remove(id: string): Promise<void>
}

/** One run of a workflow, as an operation reads it. */
export interface WorkflowRun {
  id: string
  workflow: string
  state: 'running' | 'sleeping' | 'succeeded' | 'failed' | 'terminated'
  startedAt: number
  finishedAt: number | null
  error: string | null
  /** What the workflow returned; null until it succeeded. */
  result: Json | null
}

/** The app's workflows. A query reads runs; a mutation also starts and ends them. */
export interface Workflows {
  /** Starts one run. The same `key` with the same input gives the run that is there; with another input it is an error. */
  start(name: string, input?: object, options?: { key?: string }): Promise<WorkflowRun>
  get(runId: string): Promise<WorkflowRun | null>
  /** The newest runs, 20 by default and 100 at most. */
  list(options?: { workflow?: string; limit?: number }): Promise<WorkflowRun[]>
  terminate(runId: string): Promise<WorkflowRun>
}

/** The app's signals. An occurrence is kept only when the call or the step succeeds. */
export interface Signals {
  /** Says that something happened. The name and the payload must be what `signals` in `defineApp` declares. */
  emit(name: string, payload: object): void
}

/** What a model call asks (docs/plans/app-models.md). The owner chooses the model in the app's config; the code says the task. */
export interface ModelRequest<Output extends z.ZodType | undefined = undefined> {
  prompt: string
  /** Data for the task, sent as JSON with the prompt: at most 256 KiB. */
  input?: Json
  /** Operations of this app that the model may call, by name. */
  tools?: string[]
  /** The shape of the result. Without it, the result is the model's text. */
  output?: Output
  /** How hard the model thinks: `low` by default. */
  effort?: 'low' | 'medium' | 'high'
  /** 300 by default, 900 at most. */
  timeoutSeconds?: number
}

/** One model call, as the host keeps it. `text` is what the model wrote so far. */
export interface ModelCall {
  id: string
  setting: string
  provider: string | null
  model: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  text: string
  steps: { tool: string; state: 'running' | 'done' | 'failed'; startedAt: number; endedAt: number | null; error: string | null }[]
  result: Json | null
  error: string | null
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

/** The app's model calls. A query reads them; a mutation also starts and cancels them. */
export interface Models {
  /** Queues one call with the model of the config field `setting`, and answers its id at once. The UI watches it with `models.watch`. */
  start(setting: string, request: ModelRequest<z.ZodType | undefined>): Promise<{ id: string }>
  get(id: string): Promise<ModelCall | null>
  /** The newest calls, without their text: 100 at most. */
  list(options?: { status?: ModelCall['status']; limit?: number }): Promise<ModelCall[]>
  cancel(id: string): Promise<ModelCall>
}

/** One value of the app's config. */
export type ConfigValue = string | number | boolean

/**
 * One field of the app's config: a setting the owner changes on the app's
 * Manage page, such as an hour or a team. It is not a secret: the UI reads it
 * too. Until the owner sets a value, the field has its default.
 */
export type ConfigField =
  | { type: 'text'; label: string; description?: string; default: string; multiline?: boolean }
  | { type: 'number'; label: string; description?: string; default: number; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; label: string; description?: string; default: boolean }
  | { type: 'choice'; label: string; description?: string; default: string; options: { value: string; label: string }[] }
  /** A model id. Leave the default empty for the model Solus writes with; the owner picks another on the Manage page. */
  | { type: 'model'; label: string; description?: string; default?: string }

export interface Context {
  /** The app's database: read-only in a query. */
  sql: Sql
  /** The values the owner gave for the secrets the app declares. One that is not set is undefined. */
  secrets: { readonly [name: string]: string | undefined }
  /** The config the app runs with, by field name: the owner's value, or the field's default. */
  config: { readonly [name: string]: ConfigValue }
  /** The integrations the app names: one of `integrations` with the caller's own connection, one of `appIntegrations` with the owner's. */
  tools: { readonly [slug: string]: { readonly [tool: string]: IntegrationTool } }
  files: Files
  signals: Signals
  workflows: Workflows
  /** Calls to a model, with the model the owner chose in the app's config. */
  models: Models
  caller: Caller
}

/** One query or one mutation, as the runner reads it. */
export interface AnyOperation {
  kind: 'query' | 'mutation'
  description: string
  input: z.ZodType
  output?: z.ZodType
  timeoutSeconds?: number
  requiresApproval?: boolean
  handler(ctx: Context, input: never): unknown
}

/** An operation with its types. The two type fields carry the input and output types to the UI; they hold nothing at run time. */
export interface Operation<Kind extends 'query' | 'mutation', Input, Output> extends AnyOperation {
  kind: Kind
  readonly inputType?: Input
  readonly outputType?: Output
}

interface OperationOptions<Schema extends z.ZodType, OutputSchema extends z.ZodType> {
  /** What the operation does, in a sentence. An agent reads it to choose the tool. */
  description?: string
  /** The input, as a Zod object schema. Omit for an operation that takes nothing. */
  input?: Schema
  /** What the operation answers. Solus refuses a result it does not accept, and an agent reads its shape. */
  output?: OutputSchema
  /** How long one call may take: 60 seconds by default, 900 at most. Use a workflow for longer work. */
  timeoutSeconds?: number
  /** True when an agent must get user approval before calling this operation. False when omitted. */
  requiresApproval?: boolean
}

type EmptyInput = z.ZodObject<{}>

function operation<Kind extends 'query' | 'mutation', Schema extends z.ZodType, OutputSchema extends z.ZodType, Output>(
  kind: Kind,
  options: OperationOptions<Schema, OutputSchema>,
  handler: (ctx: Context, input: z.output<Schema>) => Output,
): Operation<Kind, z.input<Schema>, Awaited<Output>> {
  return {
    kind,
    description: options.description ?? '',
    input: options.input ?? z.object({}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.requiresApproval !== undefined ? { requiresApproval: options.requiresApproval } : {}),
    handler: handler as (ctx: Context, input: never) => unknown,
  }
}

/** An operation that reads. It gets a read-only database. It may still call a service. */
export function query<Schema extends z.ZodType = EmptyInput, OutputSchema extends z.ZodType = z.ZodType, Output = unknown>(
  options: OperationOptions<Schema, OutputSchema>,
  handler: (ctx: Context, input: z.output<Schema>) => Output,
): Operation<'query', z.input<Schema>, Awaited<Output>> {
  return operation('query', options, handler)
}

/** An operation that writes. When it changes the database, each open UI of the app runs its queries again. */
export function mutation<Schema extends z.ZodType = EmptyInput, OutputSchema extends z.ZodType = z.ZodType, Output = unknown>(
  options: OperationOptions<Schema, OutputSchema>,
  handler: (ctx: Context, input: z.output<Schema>) => Output,
): Operation<'mutation', z.input<Schema>, Awaited<Output>> {
  return operation('mutation', options, handler)
}

export interface OperationMap {
  [name: string]: AnyOperation
}

// ─── Workflows: durable steps, retries, and sleep ───

/** A length of time: milliseconds, or text such as `'30 seconds'`, `'5 minutes'`, `'2 hours'`, `'1 day'`. */
export type Duration = number | `${number} ${'second' | 'seconds' | 'minute' | 'minutes' | 'hour' | 'hours' | 'day' | 'days'}`

export interface StepOptions {
  /** How many more times a failed step runs, and the wait before each one. */
  retries?: { limit: number; delay?: Duration; backoff?: 'constant' | 'linear' | 'exponential' }
  /** How long one attempt may take: 5 minutes by default, 30 at most. */
  timeout?: Duration
}

/** What a step's function gets. A step has no `sql`: change app data with `step.runMutation`. */
export interface StepContext {
  /** Aborts when the attempt is out of time or the run was ended. Pass it to `fetch`. */
  signal: AbortSignal
  /** 1 for the first attempt. */
  attempt: number
  /** The same text for each attempt of this step of this run: give it to a service that takes an idempotency key. */
  idempotencyKey: string
  secrets: Context['secrets']
  config: Context['config']
  tools: Context['tools']
  files: Files
  signals: Signals
}

export interface Step {
  /** Runs `fn` and keeps its JSON result. A run that starts again does not run a finished step again. */
  do<T>(name: string, fn: (step: StepContext) => T | Promise<T>): Promise<T>
  do<T>(name: string, options: StepOptions, fn: (step: StepContext) => T | Promise<T>): Promise<T>
  sleep(name: string, duration: Duration): Promise<void>
  sleepUntil(name: string, time: number | Date): Promise<void>
  /** One call of a query of this app. */
  runQuery<T = Json>(name: string, operation: string, input?: object): Promise<T>
  /** One call of a mutation of this app: how a run changes app data. */
  runMutation<T = Json>(name: string, operation: string, input?: object): Promise<T>
  /** One model call that the step waits for. Its result is kept, so a run that starts again does not pay for it twice. */
  model<Output extends z.ZodType | undefined = undefined>(name: string, setting: string, request: ModelRequest<Output>): Promise<Output extends z.ZodType ? z.output<Output> : string>
}

export interface WorkflowContext {
  runId: string
  step: Step
}

/** One workflow, as the runner reads it. */
export interface AnyWorkflow {
  description: string
  input: z.ZodType
  handler(ctx: WorkflowContext, input: never): unknown
}

/**
 * A function that Solus runs to its end, also across a deploy, a stop, and a
 * restart of the host. Solus keeps the result of each step. When the run
 * starts again, the function runs from its top and each finished step answers
 * from what was kept. So put time, random values, and I/O inside a step, and
 * give each step of one run its own name.
 */
export function workflow<Schema extends z.ZodType = EmptyInput>(
  options: { description?: string; input?: Schema },
  handler: (ctx: WorkflowContext, input: z.output<Schema>) => unknown,
): AnyWorkflow {
  return { description: options.description ?? '', input: options.input ?? z.object({}), handler: handler as (ctx: WorkflowContext, input: never) => unknown }
}

/** Throw it in a step to fail the step at once, with no more attempts. */
export class NonRetryableError extends Error {
  override name = 'NonRetryableError'
}

// ─── Signals: typed events the app emits ───

/** One signal, as the runner reads it. */
export interface AnySignal {
  description: string
  payload: z.ZodType
}

/** Something the app says happened. The owner decides what it does: a notification, a prompt to a session, or a run of an automation. */
export function signal<Schema extends z.ZodType>(options: { description?: string; payload: Schema }): AnySignal {
  return { description: options.description ?? '', payload: options.payload }
}

type MutationName<Operations extends OperationMap> = { [Name in keyof Operations]: Operations[Name] extends { kind: 'mutation' } ? Name : never }[keyof Operations] & string

export type ScheduleDeclaration<Operations extends OperationMap> =
  | { every: { minutes: number }; run: MutationName<Operations>; input?: { [key: string]: Json } }
  | { cron: string; timezone?: string; run: MutationName<Operations>; input?: { [key: string]: Json } }

/** Where a value of a request is: a header, one `key=value` part of a header, or the bearer token. */
export type WebhookValueSource =
  | { kind: 'header'; name: string }
  | { kind: 'header_part'; name: string; key: string; separator: ',' | ';' }
  | { kind: 'bearer' }

interface WebhookSignedCheck {
  /** A template: `{{body}}` is the raw body; `{{headers.name}}` is a header. */
  signedText: string
  signature: { source: WebhookValueSource; format: { encoding: 'hex' | 'base64'; prefix?: string; listSeparator?: string } }
  timestamp?: { source: WebhookValueSource; toleranceSeconds: number }
}

/** How Solus checks a request before the mutation runs (the schemes of Settings → Webhooks). */
export type WebhookVerification =
  | ({ scheme: 'hmac'; algorithm: 'sha256' | 'sha1' | 'sha512' } & WebhookSignedCheck)
  | ({ scheme: 'public_key'; algorithm: 'ed25519' | 'ecdsa-p256'; publicKey: string } & WebhookSignedCheck)
  | { scheme: 'token'; source: WebhookValueSource }
  | { scheme: 'jwt'; source: WebhookValueSource; issuer: string; audience: string; jwksUrl: string }
  | { scheme: 'standard_webhooks' }
  | { scheme: 'none'; reason: string }

export interface WebhookDeclaration<Operations extends OperationMap> {
  verify: WebhookVerification
  /** A template, such as `{{headers.x-github-delivery}}`: a second delivery with the same key runs nothing. */
  replayKey?: string
  /** The mutation a delivery runs. Give it `webhookRequest` as its input. */
  run: MutationName<Operations>
}

/** The input of a mutation that a webhook runs: the request's headers (lower-case names), its query, and its body (JSON when it is JSON, else text). */
export const webhookRequest = z.object({
  headers: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  body: z.unknown(),
})

export interface AppPermissions {
  /** Hosts the backend and the UI reach: a host, a host with a port, `*.example.com`, or `*`. */
  network?: string[]
  /** Host paths the backend reads and writes, absolute or under `~/`; `*` is every path. A path it may write, it may read. */
  files?: { read?: string[]; write?: string[] }
}

export interface AppInput<Operations extends OperationMap, Config extends { [name: string]: ConfigField } = {}> {
  name: string
  description?: string
  /** What an agent must know to use the app well, in a few sentences. */
  instructions?: string
  /** False for an app with no UI: its operations are what an agent, a schedule, and a webhook call. */
  ui?: boolean
  permissions?: AppPermissions
  /**
   * The slugs of the integrations the app calls through `tools` with the
   * caller's own connection. A call with no person (a schedule, a webhook, a
   * workflow, a visitor of a public app) cannot use one.
   */
  integrations?: string[]
  /**
   * The slugs of the integrations the app calls with the owner's connection,
   * for each caller and for the app's background work. The owner links the
   * connection one time. A name is in `integrations` or here, never in both.
   */
  appIntegrations?: string[]
  /** Values the owner gives in the app's menu, such as a database URL. */
  secrets?: { [name: string]: { label: string; description?: string } }
  /** Settings the owner changes on the app's Manage page. `ctx.config` and the UI's `useConfig` read them. */
  config?: Config
  operations?: Operations
  schedules?: { [name: string]: ScheduleDeclaration<Operations> }
  webhooks?: { [name: string]: WebhookDeclaration<Operations> }
  workflows?: { [name: string]: AnyWorkflow }
  /** Names are lower-case words with dots, such as `report.ready`. */
  signals?: { [name: string]: AnySignal }
}

export interface AppDefinition<Operations extends OperationMap, Config extends { [name: string]: ConfigField } = {}> extends AppInput<Operations, Config> {
  operations: Operations
  /** What Solus reads of the app: names and schemas, no code. The build calls it. */
  descriptor(): { [key: string]: Json }
}

function triggerOf(schedule: { every: { minutes: number } } | { cron: string; timezone?: string }): { [key: string]: Json } {
  if ('every' in schedule) return { type: 'interval', everyMinutes: schedule.every.minutes }
  return schedule.timezone ? { type: 'cron', expr: schedule.cron, timezone: schedule.timezone } : { type: 'cron', expr: schedule.cron }
}

export function defineApp<Operations extends OperationMap = {}, Config extends { [name: string]: ConfigField } = {}>(definition: AppInput<Operations, Config>): AppDefinition<Operations, Config> {
  const operations = definition.operations ?? ({} as Operations)
  return {
    ...definition,
    operations,
    descriptor: () => ({
      solusApp: 4,
      name: definition.name,
      description: definition.description ?? '',
      instructions: definition.instructions ?? '',
      permissions: {
        network: definition.permissions?.network ?? [],
        files: { read: definition.permissions?.files?.read ?? [], write: definition.permissions?.files?.write ?? [] },
      },
      integrations: [...(definition.integrations ?? []), ...(definition.appIntegrations ?? [])],
      appIntegrations: definition.appIntegrations ?? [],
      secrets: Object.entries(definition.secrets ?? {}).map(([name, secret]) => ({ name, label: secret.label, description: secret.description ?? '' })),
      config: Object.entries(definition.config ?? {}).map(([name, field]) => JSON.parse(JSON.stringify({ name, ...field, description: field.description ?? '' })) as { [key: string]: Json }),
      operations: Object.entries(operations).map(([name, declared]) => ({
        name,
        kind: declared.kind,
        description: declared.description,
        input: z.toJSONSchema(declared.input, { target: 'draft-7', io: 'input' }) as { [key: string]: Json },
        ...(declared.output ? { output: z.toJSONSchema(declared.output, { target: 'draft-7', io: 'output' }) as { [key: string]: Json } } : {}),
        ...(declared.timeoutSeconds ? { timeoutSeconds: declared.timeoutSeconds } : {}),
        ...(declared.requiresApproval !== undefined ? { requiresApproval: declared.requiresApproval } : {}),
      })),
      schedules: Object.entries(definition.schedules ?? {}).map(([name, schedule]) => ({
        name,
        trigger: triggerOf(schedule),
        run: schedule.run,
        input: schedule.input ?? {},
      })),
      webhooks: Object.entries(definition.webhooks ?? {}).map(([name, webhook]) => ({
        name,
        verify: webhook.verify as unknown as { [key: string]: Json },
        ...(webhook.replayKey ? { replayKey: webhook.replayKey } : {}),
        run: webhook.run,
      })),
      workflows: Object.entries(definition.workflows ?? {}).map(([name, declared]) => ({
        name,
        description: declared.description,
        input: z.toJSONSchema(declared.input, { target: 'draft-7', io: 'input' }) as { [key: string]: Json },
      })),
      signals: Object.entries(definition.signals ?? {}).map(([name, declared]) => ({
        name,
        description: declared.description,
        payload: z.toJSONSchema(declared.payload, { target: 'draft-7', io: 'input' }) as { [key: string]: Json },
      })),
    }),
  }
}
