import { z } from 'zod'
import { MCP_APP_MAX_DATA_BYTES, type McpAppCsp } from './mcp-apps'

/**
 * Apps (docs/plans/apps.md): a work of type `app`. Its content is one React
 * component, or the bundle an app project builds. An app builds with its own
 * storage, the network hosts it names, its own host functions, and the
 * viewer's integrations; every one leaves the frame as data and is checked by
 * the server.
 */

const APP_CALL_NAME_SEPARATOR = '/'
const APP_STORAGE_CALL_PREFIX = '@storage/'
const APP_SERVER_CALL_PREFIX = '@server/'

/** What the frame puts on the wire: `<slug>/<tool>`, `@storage/<operation>`, or `@server/<function>`. */
export const appCallNameSchema = z.string().min(3).max(512).regex(/^[^/\s]+\/[^\s]+$/)

/** `<slug>/<tool>`, an integration tool as the permissions list it. A slug never starts with `@`. */
export const appToolNameSchema = appCallNameSchema.refine((name) => !name.startsWith('@'))

/** A network host an app may reach: `api.example.com`, `*.example.com`, `db.internal:5432`, or `*` for every host. */
const appNetworkHostSchema = z.string().max(256).regex(/^(?:\*|(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)$/i)
const appNetworkSchema = z.array(appNetworkHostSchema).max(32)

/** A host path an app's host functions may use: absolute, under `~`, or `*` for every path. */
const appFilePathSchema = z.string().max(1024).regex(/^(?:\*|~(?:[\\/].*)?|\/.*|[A-Za-z]:[\\/].*)$/)
const appFilePathsSchema = z.array(appFilePathSchema).max(32)
const appFilesSchema = z.object({ read: appFilePathsSchema.default([]), write: appFilePathsSchema.default([]) })

/**
 * The app's own settings (§5). `tools` and `writes` are its ceiling under the
 * gateway's: they can narrow what the viewer's integrations allow, never widen
 * it. `network` and `files` are what it asks of the host; they are in force
 * only when the host's owner allowed them (§6).
 */
export const appPermissionsSchema = z.object({
  tools: z.union([z.literal('all'), z.literal('read-only'), z.object({ selected: z.array(appToolNameSchema).max(256) })]).default('all'),
  writes: z.enum(['ask', 'allow']).default('ask'),
  network: appNetworkSchema.default([]),
  files: appFilesSchema.default({ read: [], write: [] }),
})
export type AppPermissions = z.infer<typeof appPermissionsSchema>

export const DEFAULT_APP_PERMISSIONS: AppPermissions = { tools: 'all', writes: 'ask', network: [], files: { read: [], write: [] } }

/** What an app asks of the host outside integrations and storage (§6). */
export const appHostAccessSchema = z.object({
  /** It has host functions: its own code runs on the host. */
  functions: z.boolean(),
  network: appNetworkSchema,
  files: z.object({ read: appFilePathsSchema, write: appFilePathsSchema }),
})
export type AppHostAccess = z.infer<typeof appHostAccessSchema>

/** What rides a work's meta for an app: its permissions, and the host access the host's owner allowed. */
export const appMetaSchema = z.object({
  permissions: appPermissionsSchema,
  allowed: appHostAccessSchema.optional(),
})
export type AppMeta = z.infer<typeof appMetaSchema>

/**
 * The built form of an app project (§3). `client` and `server` are CommonJS
 * module bodies: the shell runs the first in the frame, the runner the second
 * on the host. `sources` are the project's own files, so a later session can
 * read and rebuild them.
 */
export const appBundleSchema = z.object({
  solusApp: z.literal(1),
  client: z.string().min(1),
  css: z.string().optional(),
  server: z.string().min(1).optional(),
  integrations: z.array(z.string().min(1).max(64)).max(64).default([]),
  sources: z.record(z.string().min(1).max(512), z.string()).optional(),
})
export type AppBundle = z.infer<typeof appBundleSchema>

/** A work's content as an app bundle; null when it is a component, or says it is a bundle and is not a valid one. */
export function parseAppBundle(content: string): AppBundle | null {
  if (!content.trimStart().startsWith('{')) return null
  try {
    const bundle = appBundleSchema.safeParse(JSON.parse(content))
    return bundle.success ? bundle.data : null
  } catch {
    return null
  }
}

/** A bundle's sources as one text, each file under a line that names it; empty when it carries none. */
export function appBundleSourceText(bundle: AppBundle): string {
  return Object.entries(bundle.sources ?? {}).map(([path, text]) => `--- ${path} ---\n${text}`).join('\n\n')
}

/**
 * An app's content as the source a person reads, copies, and compares: a
 * component is its own source, a bundle is its sources. The compiled code of
 * a bundle is never source.
 */
export function appSourceText(content: string): string {
  const bundle = parseAppBundle(content)
  if (!bundle) return content
  return appBundleSourceText(bundle) || 'This app is a bundle that carries no sources.'
}

/** One integration the app names (the slug in `tools.<slug>.<tool>`), as the viewer sees it. */
export interface AppRoleState {
  slug: string
  /** The name of the viewer's integration with that slug; null when they have none. */
  name: string | null
  connected: boolean
}

/** `none`: the app asks for nothing. `pending`: it asks for more than the owner allowed. `allowed`: what it asks is in force. */
export type AppHostAccessState = 'none' | 'pending' | 'allowed'

/** The app's host access as a header shows it. */
export interface AppHostAccessView {
  asks: AppHostAccess
  state: AppHostAccessState
  /** The caller is the host's owner, who alone allows and revokes. */
  canDecide: boolean
}

/** What a client gets to show an app: the composed document and the facts its header shows. */
export interface AppSnapshot {
  html: string
  csp: McpAppCsp
  title: string
  roles: AppRoleState[]
  permissions: AppPermissions
  hostAccess: AppHostAccessView
  contentVersion: number
}

export const appRequestSchema = z.object({ workId: z.string().min(1) })
export type AppRequest = z.infer<typeof appRequestSchema>

export const appToolRequestSchema = appRequestSchema.extend({ name: appCallNameSchema })
export type AppToolRequest = z.infer<typeof appToolRequestSchema>

export const appCallRequestSchema = appToolRequestSchema.extend({
  argumentsJson: z.string().max(MCP_APP_MAX_DATA_BYTES),
  approved: z.boolean(),
})
export type AppCallRequest = z.infer<typeof appCallRequestSchema>

export const appPermissionsUpdateSchema = appRequestSchema.extend({ permissions: appPermissionsSchema })
export type AppPermissionsUpdate = z.infer<typeof appPermissionsUpdateSchema>

/** `allow: true` puts what the app asks now in force; `false` revokes it. */
export const appHostAccessDecisionSchema = appRequestSchema.extend({ allow: z.boolean() })
export type AppHostAccessDecision = z.infer<typeof appHostAccessDecisionSchema>

export const APP_STORAGE_OPERATIONS = ['get', 'set', 'delete', 'keys'] as const
export type AppStorageOperation = (typeof APP_STORAGE_OPERATIONS)[number]

/** What a call name addresses. */
export type AppCall =
  | { kind: 'tool'; slug: string; tool: string }
  | { kind: 'storage'; operation: AppStorageOperation }
  | { kind: 'function'; name: string }

export function appStorageCallName(operation: AppStorageOperation): string {
  return `${APP_STORAGE_CALL_PREFIX}${operation}`
}

export function appFunctionCallName(name: string): string {
  return `${APP_SERVER_CALL_PREFIX}${name}`
}

/** What a call name addresses, or null when it addresses nothing. */
export function parseAppCallName(name: string): AppCall | null {
  if (name.startsWith(APP_STORAGE_CALL_PREFIX)) {
    const operation = APP_STORAGE_OPERATIONS.find((known) => known === name.slice(APP_STORAGE_CALL_PREFIX.length))
    return operation ? { kind: 'storage', operation } : null
  }
  if (name.startsWith(APP_SERVER_CALL_PREFIX)) {
    const functionName = name.slice(APP_SERVER_CALL_PREFIX.length)
    return functionName ? { kind: 'function', name: functionName } : null
  }
  const at = name.indexOf(APP_CALL_NAME_SEPARATOR)
  if (name.startsWith('@') || at <= 0 || at === name.length - 1) return null
  return { kind: 'tool', slug: name.slice(0, at), tool: name.slice(at + 1) }
}

/** A one-line reading of the integration permissions, for a header. */
export function describeAppPermissions(permissions: Pick<AppPermissions, 'tools' | 'writes'>): string {
  const tools = permissions.tools === 'all' ? 'All tools' : permissions.tools === 'read-only' ? 'Read-only tools' : `${permissions.tools.selected.length} selected tools`
  return `${tools} · writes ${permissions.writes === 'ask' ? 'ask first' : 'run on click'}`
}

function listed(entries: readonly string[], every: string): string {
  return entries.includes('*') ? every : entries.join(', ')
}

/**
 * What a host access lets an app do, as the end of a sentence that starts
 * "This app asks to" or "This app can": "run its own code on this host, read
 * every file, and reach api.example.com". Empty when it lets it do nothing.
 */
export function describeAppHostAccess(access: AppHostAccess): string {
  const clauses: string[] = []
  if (access.functions) {
    clauses.push('run its own code on this host')
    if (access.files.read.length > 0) clauses.push(`read ${listed(access.files.read, 'every file')}`)
    if (access.files.write.length > 0) clauses.push(`write ${listed(access.files.write, 'every file')}`)
  }
  if (access.network.length > 0) clauses.push(`reach ${listed(access.network, 'every network host')}`)
  if (clauses.length <= 2) return clauses.join(' and ')
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}`
}

/** What a header says of an app's host access, on every client; null when the app asks for nothing. */
export function appHostAccessNotice(view: AppHostAccessView): string | null {
  if (view.state === 'none') return null
  const access = describeAppHostAccess(view.asks)
  if (view.state === 'allowed') return `This app can ${access}.`
  return view.canDecide
    ? `This app asks to ${access}. An agent wrote it. Until you allow it, those parts of the app do not work.`
    : `This app asks to ${access}. Only the owner of its host can allow that.`
}
