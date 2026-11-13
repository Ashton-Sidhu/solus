// `@solus/app/backend`: what an app's backend is written with. A project is
// an app when it has an `app.ts` next to `package.json` that exports
// `defineApp({ ... })` as its default (see the skill's references/apps.md).
//
// Do not edit. The build bundles this file into the backend, and Solus reads
// what `descriptor()` answers.

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
}

/** The app's own SQLite database. The schema comes from `migrations/`. */
export interface Sql {
  /** Runs one statement now, with `?` values. It commits by itself unless a transaction is open. */
  exec<Row = { [column: string]: SqlValue }>(text: string, ...values: SqlValue[]): SqlRows<Row>
  /** Groups statements: all of them commit, or none. `run` is synchronous: do network work before or after it. */
  transaction<T>(run: () => T): T
}

/** Who started the call. */
export type Caller =
  | { kind: 'ui' }
  | { kind: 'agent'; sessionId: string | null }
  | { kind: 'schedule'; name: string }
  | { kind: 'webhook'; webhookId: string }

/** One tool of an integration: `ctx.tools.linear.list_issues({ team })`. `T` is the type you expect back. */
export type IntegrationTool = <T = Json>(input?: object) => Promise<T>

export interface Context {
  /** The app's database: read-only in a query. */
  sql: Sql
  /** The values the owner gave for the secrets the app declares. One that is not set is undefined. */
  secrets: { readonly [name: string]: string | undefined }
  /** The integrations the app names in `integrations`, with the caller's own connection. */
  tools: { readonly [slug: string]: { readonly [tool: string]: IntegrationTool } }
  /** A folder that is the app's own: always readable and writable. */
  files: string
  caller: Caller
}

/** One query or one mutation, as the runner reads it. */
export interface AnyOperation {
  kind: 'query' | 'mutation'
  description: string
  input: z.ZodType
  handler(ctx: Context, input: never): unknown
}

/** An operation with its types. The two type fields carry the input and output types to the UI; they hold nothing at run time. */
export interface Operation<Kind extends 'query' | 'mutation', Input, Output> extends AnyOperation {
  kind: Kind
  readonly inputType?: Input
  readonly outputType?: Output
}

interface OperationOptions<Schema extends z.ZodType> {
  /** What the operation does, in a sentence. An agent reads it to choose the tool. */
  description?: string
  /** The input, as a Zod object schema. Omit for an operation that takes nothing. */
  input?: Schema
}

type EmptyInput = z.ZodObject<{}>

function operation<Kind extends 'query' | 'mutation', Schema extends z.ZodType, Output>(
  kind: Kind,
  options: OperationOptions<Schema>,
  handler: (ctx: Context, input: z.output<Schema>) => Output,
): Operation<Kind, z.input<Schema>, Awaited<Output>> {
  return { kind, description: options.description ?? '', input: options.input ?? z.object({}), handler: handler as (ctx: Context, input: never) => unknown }
}

/** An operation that reads. It gets a read-only database. It may still call a service. */
export function query<Schema extends z.ZodType = EmptyInput, Output = unknown>(
  options: OperationOptions<Schema>,
  handler: (ctx: Context, input: z.output<Schema>) => Output,
): Operation<'query', z.input<Schema>, Awaited<Output>> {
  return operation('query', options, handler)
}

/** An operation that writes. When it changes the database, each open UI of the app runs its queries again. */
export function mutation<Schema extends z.ZodType = EmptyInput, Output = unknown>(
  options: OperationOptions<Schema>,
  handler: (ctx: Context, input: z.output<Schema>) => Output,
): Operation<'mutation', z.input<Schema>, Awaited<Output>> {
  return operation('mutation', options, handler)
}

export interface OperationMap {
  [name: string]: AnyOperation
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

export interface AppInput<Operations extends OperationMap> {
  name: string
  description?: string
  /** False for an app with no UI: its operations are what an agent, a schedule, and a webhook call. */
  ui?: boolean
  permissions?: AppPermissions
  /** The slugs of the integrations the app calls through `tools`. */
  integrations?: string[]
  /** Values the owner gives in the app's menu, such as a database URL. */
  secrets?: { [name: string]: { label: string; description?: string } }
  operations?: Operations
  schedules?: { [name: string]: ScheduleDeclaration<Operations> }
  webhooks?: { [name: string]: WebhookDeclaration<Operations> }
}

export interface AppDefinition<Operations extends OperationMap> extends AppInput<Operations> {
  operations: Operations
  /** What Solus reads of the app: names and schemas, no code. The build calls it. */
  descriptor(): { [key: string]: Json }
}

function triggerOf(schedule: { every: { minutes: number } } | { cron: string; timezone?: string }): { [key: string]: Json } {
  if ('every' in schedule) return { type: 'interval', everyMinutes: schedule.every.minutes }
  return schedule.timezone ? { type: 'cron', expr: schedule.cron, timezone: schedule.timezone } : { type: 'cron', expr: schedule.cron }
}

export function defineApp<Operations extends OperationMap = {}>(definition: AppInput<Operations>): AppDefinition<Operations> {
  const operations = definition.operations ?? ({} as Operations)
  return {
    ...definition,
    operations,
    descriptor: () => ({
      solusApp: 2,
      name: definition.name,
      description: definition.description ?? '',
      permissions: {
        network: definition.permissions?.network ?? [],
        files: { read: definition.permissions?.files?.read ?? [], write: definition.permissions?.files?.write ?? [] },
      },
      integrations: definition.integrations ?? [],
      secrets: Object.entries(definition.secrets ?? {}).map(([name, secret]) => ({ name, label: secret.label, description: secret.description ?? '' })),
      operations: Object.entries(operations).map(([name, declared]) => ({
        name,
        kind: declared.kind,
        description: declared.description,
        input: z.toJSONSchema(declared.input, { target: 'draft-7', io: 'input' }) as { [key: string]: Json },
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
    }),
  }
}
