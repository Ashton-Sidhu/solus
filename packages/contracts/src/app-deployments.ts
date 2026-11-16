/**
 * A deployment of an app (docs/plans/app-deploy.md): a published copy of one
 * version that runs in a container, outside Solus. The app stays in Solus,
 * where its owner and their agents work on it; a publish sends a built
 * version to the deployment. This file is what the two sides say to each
 * other, and what a client reads of a deployment. Zod is the contract, so
 * each side decodes one shape.
 */

import { z } from 'zod'
import { APP_MODEL_OPERATIONS, APP_PROTOCOLS, appCallerRoleSchema, appCallerSchema, appCallerUserSchema, appDescriptorSchema } from './apps'
import { shareNamedSubjectSchema } from './sharing'

// ─── The management API: what Solus asks of a deployment (§5.3) ───

/** The paths of the management API. Solus signs each request with the app key. */
export const APP_MANAGEMENT_PATHS = {
  /** Unsigned: a platform asks only whether the process answers, and when it must run next. */
  health: '/_solus/v1/health',
  status: '/_solus/v1/status',
  versions: '/_solus/v1/versions',
  /** One operation of the app, for a model call that Solus runs for the deployment and that uses the operation as a tool. */
  operations: '/_solus/v1/operations',
} as const

/** What the health path answers. `nextWakeAt` is when the app's next schedule or sleeping run is due; null with none. A platform that stops an idle container starts it again then. */
export const appRuntimeHealthSchema = z.object({ ok: z.literal(true), nextWakeAt: z.number().nullable().default(null) })
export type AppRuntimeHealth = z.infer<typeof appRuntimeHealthSchema>

/** `operations`: one operation with its input and who calls it. */
export const appManagementOperationSchema = z.object({ operation: z.string().min(1).max(200), input: z.json(), caller: appCallerSchema })
export type AppManagementOperation = z.infer<typeof appManagementOperationSchema>

/** The header that carries the signature of a management request. */
export const APP_MANAGEMENT_SIGNATURE_HEADER = 'solus-signature'

/** The app key: `sak_` and 32 random bytes. It names one deployment to Solus and signs what Solus asks of it. */
export const appKeySchema = z.string().regex(/^sak_[A-Za-z0-9_-]{43}$/)

/**
 * Who a deployment answers at its address: each person who has its link, each
 * person, or the people, teams, and organizations that its owner names, who
 * each sign in to Solus (§7.3).
 */
export const appAccessModeSchema = z.enum(['link', 'public', 'people'])
export type AppAccessMode = z.infer<typeof appAccessModeSchema>

/** What a visitor may do: a viewer runs queries, an editor runs queries and mutations. */
export const appVisitorRoleSchema = z.enum(['viewer', 'editor'])
export type AppVisitorRole = z.infer<typeof appVisitorRoleSchema>

/** The secret of a deployment's link: 32 random bytes. The link is the address with the secret in its fragment. */
export const appLinkSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** One named subject of a deployment with the access `people`, and what it may do. */
export const appAccessSubjectSchema = z.object({ subject: shareNamedSubjectSchema, role: appVisitorRoleSchema })
export type AppAccessSubject = z.infer<typeof appAccessSubjectSchema>

/**
 * Where a deployment with the access `people` sends a visitor to sign in
 * (§7.3): the origin of Solus Cloud, and the name Solus Cloud has for this
 * published app. Solus Cloud keeps the list of subjects and decides the role.
 */
export const appSignInSchema = z.object({ origin: z.string().url(), app: z.string().min(1).max(100) })
export type AppSignIn = z.infer<typeof appSignInSchema>

/** The access of a deployment, as Solus sends it with a version. The deployment keeps only a hash of the secret. */
export const appAccessSchema = z.object({
  mode: appAccessModeSchema,
  /** What a visitor may do with the link or in a public app. With `people`, each subject has its own role. */
  role: appVisitorRoleSchema,
  linkSecret: appLinkSecretSchema,
  /** Present with the access `people`. */
  signIn: appSignInSchema.optional(),
})
export type AppAccess = z.infer<typeof appAccessSchema>

const appMigrationSchema = z.object({ name: z.string().min(1).max(200), sql: z.string() })
const appConfigValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

/** The build of one version, as Solus made it: a deployment does not build (decision 6). */
export const appBuildSchema = z.object({
  descriptor: appDescriptorSchema,
  /** The backend module, CommonJS for Node; null when the app declares no operation. */
  backend: z.string().nullable(),
  /** The UI, one built HTML file; null when the app has none. */
  ui: z.string().nullable(),
  migrations: z.array(appMigrationSchema).max(1000),
})
export type AppBuildPayload = z.infer<typeof appBuildSchema>

/** One built version on its way to a deployment. The number is the one the version has in Solus. */
export const appVersionPushSchema = z.object({
  app: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    slug: z.string().min(1).max(80),
  }),
  number: z.number().int().positive(),
  /** The revision the version was built from. A deployment has no source: this is a name only. */
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  message: z.string().max(2000),
  build: appBuildSchema,
  /** The config the app runs with in Solus at the time of the publish. The deployment runs with the same. */
  config: appConfigValuesSchema.default({}),
  /** Absent from Solus's own read of an app; a publish always sends it. Without it the access of the deployment stays. */
  access: appAccessSchema.optional(),
})
export type AppVersionPush = z.infer<typeof appVersionPushSchema>

/** What a deployment answers a pushed version with. */
export const appVersionPushReceiptSchema = z.object({
  version: z.number(),
  /** False when the version did not start: the version before it still runs. */
  active: z.boolean(),
  error: z.string().nullable(),
})
export type AppVersionPushReceipt = z.infer<typeof appVersionPushReceiptSchema>

/** What a deployment says of itself. */
export const appDeploymentStatusSchema = z.object({
  runtime: z.object({
    /** The Solus release the runtime image was made from. */
    release: z.string(),
    /** The app protocols this runtime runs. */
    protocols: z.array(z.number()),
  }),
  /** The version that runs; null before the first one arrived. */
  activeVersion: z.number().nullable(),
  /** The calls of the last 24 hours, and how many failed. */
  calls24h: z.number(),
  failed24h: z.number(),
  access: appAccessModeSchema.nullable(),
})
export type AppDeploymentStatus = z.infer<typeof appDeploymentStatusSchema>
export const APP_RUNTIME_PROTOCOLS: readonly number[] = APP_PROTOCOLS

/** The person of a call of an app's UI, and what they may do in the app. It is `ctx.caller` of the call. */
export const appUiIdentitySchema = z.object({ user: appCallerUserSchema.optional(), role: appCallerRoleSchema.optional() })
export type AppUiIdentity = z.infer<typeof appUiIdentitySchema>

/** The env vars of a deployment (decision 14). */
export const APP_DEPLOYMENT_ENV = {
  appKey: 'SOLUS_APP_KEY',
  solusUrl: 'SOLUS_URL',
  port: 'PORT',
  dataDir: 'SOLUS_DATA_DIR',
  /** `SOLUS_APP_SECRET_<NAME>`: one of the app's own secrets. */
  secretPrefix: 'SOLUS_APP_SECRET_',
  /** `SOLUS_APP_WEBHOOK_SECRET_<NAME>`: the signing secret of one webhook the app declares, base64. */
  webhookSecretPrefix: 'SOLUS_APP_WEBHOOK_SECRET_',
  /** An exported image only: the file of the version it holds, and who it answers. No Solus sends these to it. */
  versionFile: 'SOLUS_APP_VERSION_FILE',
  access: 'SOLUS_APP_ACCESS',
  role: 'SOLUS_APP_ROLE',
  linkSecret: 'SOLUS_APP_LINK_SECRET',
} as const

/** The env var of one of the app's own secrets: the declared name in capitals, each other character as `_`. */
export function appSecretEnvName(secret: string): string {
  return `${APP_DEPLOYMENT_ENV.secretPrefix}${secret.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

/** The env var of the signing secret of one declared webhook. */
export function appWebhookSecretEnvName(webhook: string): string {
  return `${APP_DEPLOYMENT_ENV.webhookSecretPrefix}${webhook.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

// ─── What a visitor's browser asks of a deployment (§7) ───

export const APP_VISITOR_PATHS = {
  /** One call of the app's UI: an operation, its storage, its config, or an app file. */
  call: '/_solus/app/call',
  /** Server-sent events: `data-changed` when the app's data changed. */
  events: '/_solus/app/events',
  /** Changes the secret of the link for a session cookie. */
  enter: '/_solus/app/enter',
  /** Access `people`: sends the browser to Solus Cloud to sign in. */
  signIn: '/_solus/app/sign-in',
  /** Access `people`: where Solus Cloud sends the browser back, with a code. */
  callback: '/_solus/app/callback',
  /** Ends the session of this browser. */
  leave: '/_solus/app/leave',
} as const

/** `<address>/_solus/hooks/<name>`: where another service sends a webhook that the app declares (§7.4). */
export const APP_WEBHOOK_PATH_PREFIX = '/_solus/hooks/'

// ─── Sign-in at the address (§7.3): what a deployment and Solus Cloud say to each other ───

/** The page of Solus Cloud that signs a visitor in and sends them back to the deployment with a code. */
export const APP_SIGN_IN_ENTER_PATH = '/apps/enter'
/** Where a deployment changes the code for the person and their role. */
export const APP_SIGN_IN_ENTRY_PATH = '/v1/apps/entry'

/** `POST /v1/apps/entry`: the code of one sign-in, and the verifier whose SHA-256 the deployment sent as the challenge. */
export const appSignInEntryRequestSchema = z.object({ app: z.string().min(1).max(100), code: z.string().min(20).max(200), verifier: z.string().min(43).max(128) })
export type AppSignInEntryRequest = z.infer<typeof appSignInEntryRequestSchema>

/** The person who signed in, and what the app's owner lets them do. The owner of the app is `owner`. */
export const appSignInEntrySchema = z.object({ user: appCallerUserSchema, role: appCallerRoleSchema })
export type AppSignInEntry = z.infer<typeof appSignInEntrySchema>

/** A call of the UI must carry this header. A page of another origin cannot send it without a preflight, which the deployment does not answer. */
export const APP_VISITOR_HEADER = 'x-solus-app'

export const appVisitorCallSchema = z.object({ name: z.string().min(1).max(400), argumentsJson: z.string().max(8 * 1024 * 1024) })
export const appVisitorEnterSchema = z.object({ secret: appLinkSecretSchema })

// ─── The service API: what a deployment asks of Solus (§5.2) ───

/** The paths of the service API on a Solus. A deployment sends its app key as a bearer token. */
export const APP_SERVICE_PATHS = {
  tool: '/apps/service/v1/tool',
  signals: '/apps/service/v1/signals',
  /** A model call (docs/plans/app-models.md): Solus runs it with the owner's model account. */
  models: '/apps/service/v1/models',
} as const
export const APP_SERVICE_PATH_PREFIX = '/apps/service/v1/'

/** One tool of an app connection (§6). Solus runs it with the owner's connection and answers the result: no token reaches the deployment (decision 15). */
export const appServiceToolSchema = z.object({
  slug: z.string().min(1).max(80),
  tool: z.string().min(1).max(200),
  input: z.record(z.string(), z.json()),
})
export type AppServiceTool = z.infer<typeof appServiceToolSchema>

/** The signals of one call or one step that succeeded. Solus keeps each occurrence and runs the owner's signal actions. */
export const appServiceSignalsSchema = z.object({
  signals: z.array(z.object({ name: z.string().min(1).max(200), payload: z.json(), id: z.string().max(200).optional() })).max(100),
  source: z.object({ callId: z.string().nullable(), runId: z.string().nullable() }),
})
export type AppServiceSignals = z.infer<typeof appServiceSignalsSchema>

/**
 * One request of the app's code or its UI for a model call. Solus runs the
 * call, and runs each operation that the call uses as a tool in the
 * deployment, through the management API. The deployment sends the config it
 * runs with, because a model setting is a value of it.
 */
export const appServiceModelsSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('code'), method: z.enum(['models.start', 'models.get', 'models.list', 'models.cancel']), input: z.json(), config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), caller: appCallerSchema }),
  z.object({ from: z.literal('ui'), operation: z.enum(APP_MODEL_OPERATIONS), input: z.json() }),
])
export type AppServiceModels = z.infer<typeof appServiceModelsSchema>

/** The answer of the service API: a value, or why Solus did not give one. */
export const appServiceAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AppServiceAnswer = z.infer<typeof appServiceAnswerSchema>

// ─── A deployment, as a client of Solus reads and changes it ───

/** The kind of place that runs a deployment (§5.4). Tailscale is not one: it is a switch of a deployment. */
export const appPlatformKindSchema = z.enum(['docker', 'solus-cloud'])
export type AppPlatformKind = z.infer<typeof appPlatformKindSchema>

/**
 * `appPublish`: sends the active version of an app to its deployment, and
 * makes the deployment first when the app has none. A thing the request does
 * not name stays as the deployment has it; on a first publish it is Docker on
 * the host of the app, no Tailscale address, a link, and the editor role.
 */
export const appPublishRequestSchema = z.object({
  appId: z.string().min(1),
  platform: appPlatformKindSchema.optional(),
  tailscaleAddress: z.boolean().optional(),
  access: appAccessModeSchema.optional(),
  role: appVisitorRoleSchema.optional(),
  /** Makes a new link: the old one stops, and each visitor who came in with it is out. */
  newLink: z.boolean().default(false),
  /** The connected host that runs the container (§8.5), from `appPublishPlaces`; null for the host of the app. Docker only. */
  hostId: z.string().min(1).max(200).nullable().optional(),
  /** With the access `people`: the whole list of who opens the app. Absent, the list stays. */
  subjects: z.array(appAccessSubjectSchema).max(200).optional(),
})
export type AppPublishRequest = z.input<typeof appPublishRequestSchema>

export const appDeploymentLogsRequestSchema = z.object({ appId: z.string().min(1), lines: z.number().int().min(1).max(2000).default(200) })
export type AppDeploymentLogsRequest = z.input<typeof appDeploymentLogsRequestSchema>

/** The deployment of an app, as its owner sees it. */
export interface AppDeploymentView {
  platform: AppPlatformKind
  /** The connected host that runs the container; null when the host of the app runs it. `isReachable` is false when this Solus does not reach it now. */
  host: { id: string; label: string; isReachable: boolean } | null
  tailscaleAddress: boolean
  access: AppAccessMode
  role: AppVisitorRole
  /** Who opens the app with the access `people`. Kept when the access is another, so a change back has the list. */
  subjects: AppAccessSubject[]
  /** Where another service sends each webhook that the published version declares. The signing secret is the one of the app in Solus. */
  webhooks: { name: string; url: string }[]
  /** The URL where a browser opens the app; null when only this host reaches the deployment. */
  address: string | null
  /** What the owner gives a person to open the app: the address, with the secret of the link when the access is `link`. */
  link: string | null
  /** The version that was published last. */
  version: number
  publishedAt: number
  createdAt: number
  /** The container runs. */
  running: boolean
  /** What the deployment says of itself; null when it does not answer. */
  status: AppDeploymentStatus | null
}

/** What a publish answers: the deployment, and whether the version started there. */
export interface AppPublishReceipt {
  deployment: AppDeploymentView
  active: boolean
  error: string | null
}

// ─── A container on a connected host (§8.5) ───

/** A connected host that can run the container of a deployment. */
export interface AppPublishHost {
  id: string
  label: string
}

/** One place that a first publish offers. */
export interface AppPublishPlace {
  platform: AppPlatformKind
  /** A connected host of the owner; null for the host of the app. */
  host: AppPublishHost | null
  /** What the place lacks to run a copy now; null when it is ready, and for a connected host, which says so only at the publish. */
  problem: string | null
}

/** What the host of an app has for a publish. */
export interface AppPublishPlaces {
  places: AppPublishPlace[]
  /** This host has a Tailscale auth key, for a copy with an address on the tailnet. */
  hasTailscaleKey: boolean
  /** The owner is signed in to Solus on this host, so the access `people` works. */
  canNamePeople: boolean
}

/** `appTailscaleKeySet`: the Tailscale auth key of this host; null removes it. */
export const appTailscaleKeySetRequestSchema = z.object({ value: z.string().trim().min(1).max(500).nullable() })
export type AppTailscaleKeySetRequest = z.infer<typeof appTailscaleKeySetRequestSchema>

const hostedAppIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** `appContainerRun`: what the Solus of an app asks a connected host to run. The app key and the app's secrets are in the env vars. */
export const appContainerRunRequestSchema = z.object({
  appId: hostedAppIdSchema,
  slug: z.string().min(1).max(80),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), z.string().max(65536)),
  tailscaleAddress: z.boolean(),
})
export type AppContainerRunRequest = z.infer<typeof appContainerRunRequestSchema>

export const appContainerRequestSchema = z.object({ appId: hostedAppIdSchema })
export type AppContainerRequest = z.infer<typeof appContainerRequestSchema>

export const appContainerLogsRequestSchema = z.object({ appId: hostedAppIdSchema, lines: z.number().int().min(1).max(2000) })
export type AppContainerLogsRequest = z.infer<typeof appContainerLogsRequestSchema>

/**
 * `appContainerManage`: one request of the management API, carried by the
 * container's host to the runtime. The host is a pipe: the runtime checks
 * the signature, which only the Solus of the app can make.
 */
export const appContainerManageRequestSchema = z.object({
  appId: hostedAppIdSchema,
  method: z.enum(['GET', 'POST']),
  path: z.enum([APP_MANAGEMENT_PATHS.health, APP_MANAGEMENT_PATHS.status, APP_MANAGEMENT_PATHS.versions]),
  signature: z.string().max(400).nullable(),
  /** The JSON text of the request; null for a GET. */
  body: z.string().max(64 * 1024 * 1024).nullable(),
})
export type AppContainerManageRequest = z.infer<typeof appContainerManageRequestSchema>

/** Where a browser opens the app of a hosted container: its address on the tailnet, or a loopback port of the container's host. */
export interface AppContainerAddress {
  address: string
}

export interface AppContainerState {
  /** The host has the container. */
  exists: boolean
  running: boolean
}

export interface AppContainerManageAnswer {
  status: number
  body: string
}
