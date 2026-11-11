import { z } from 'zod'
import { MCP_APP_MAX_DATA_BYTES } from './mcp-apps'

/**
 * Apps (docs/plans/apps.md): an `artifact` work whose page carries an app
 * manifest. The manifest turns on the app's own storage, the network hosts it
 * names, its own host functions, and the viewer's integrations; every one
 * leaves the frame as data and is checked by the server.
 */

const APP_CALL_NAME_SEPARATOR = '/'
const APP_STORAGE_CALL_PREFIX = '@storage/'
const APP_SERVER_CALL_PREFIX = '@server/'

/** What the page puts on the wire: `<slug>/<tool>`, `@storage/<operation>`, or `@server/<function>`. */
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
 * What an app declares in its project's `app.json` (§5). `tools` is its
 * ceiling under the gateway's: it can narrow what the viewer's integrations
 * allow, never widen it. `writes: 'allow'`, `network`, and `files` are in
 * force only when the host's owner allowed them (§6).
 */
export const appPermissionsSchema = z.object({
  tools: z.union([z.literal('all'), z.literal('read-only'), z.object({ selected: z.array(appToolNameSchema).max(256) })]).default('all'),
  writes: z.enum(['ask', 'allow']).default('ask'),
  network: appNetworkSchema.default([]),
  files: appFilesSchema.default({ read: [], write: [] }),
})
export type AppPermissions = z.infer<typeof appPermissionsSchema>

export const DEFAULT_APP_PERMISSIONS: AppPermissions = { tools: 'all', writes: 'ask', network: [], files: { read: [], write: [] } }

/**
 * The app manifest (§3): one JSON block the build writes into the page.
 * `server` is a CommonJS module for Node; each of its exported functions is a
 * host function. `sources` are the project's own files, so a later session
 * can read and rebuild them.
 */
export const appManifestSchema = z.object({
  solusApp: z.literal(1),
  permissions: appPermissionsSchema.default(DEFAULT_APP_PERMISSIONS),
  integrations: z.array(z.string().min(1).max(64)).max(64).default([]),
  server: z.string().min(1).optional(),
  sources: z.record(z.string().min(1).max(512), z.string()).optional(),
})
export type AppManifest = z.infer<typeof appManifestSchema>

const MANIFEST_OPEN = '<script type="application/json" id="solus-app">'
const MANIFEST_CLOSE = '</script>'

/** The manifest as the block a build writes into a page. Every `<` is escaped, so nothing in it can end the script element. */
export function appManifestBlock(manifest: AppManifest): string {
  return `${MANIFEST_OPEN}${JSON.stringify(manifest).replace(/</g, '\\u003c')}${MANIFEST_CLOSE}`
}

/**
 * Whether a page has an app manifest block. A frame's policy is decided from
 * this alone, with no parse: a page that says it is an app runs as one.
 */
export function hasAppManifest(html: string): boolean {
  return html.includes(MANIFEST_OPEN)
}

/** What a page says of itself: no manifest block, a valid manifest, or a block that is not one. */
export type AppPageRead = { kind: 'none' } | { kind: 'app'; manifest: AppManifest } | { kind: 'invalid'; problem: string }

/**
 * Reads the app manifest of a page. This is the one reader, for the server
 * and for every client: a frame's policy, a call's permissions, and a save's
 * check all come from the same answer for the same text.
 */
export function readAppPage(html: string): AppPageRead {
  const start = html.indexOf(MANIFEST_OPEN)
  if (start < 0) return { kind: 'none' }
  const end = html.indexOf(MANIFEST_CLOSE, start)
  if (end < 0) return { kind: 'invalid', problem: 'The app manifest block does not end.' }
  let manifest: ReturnType<typeof appManifestSchema.safeParse>
  try {
    manifest = appManifestSchema.safeParse(JSON.parse(html.slice(start + MANIFEST_OPEN.length, end)))
  } catch {
    return { kind: 'invalid', problem: 'The app manifest is not JSON.' }
  }
  if (manifest.success) return { kind: 'app', manifest: manifest.data }
  const issue = manifest.error.issues[0]
  return { kind: 'invalid', problem: `The app manifest is not valid: ${issue ? `${issue.path.join('.') || 'manifest'}: ${issue.message}` : 'unknown shape'}.` }
}

/** A page's manifest, or null when the page is not a valid app. */
export function appManifestOf(html: string): AppManifest | null {
  const read = readAppPage(html)
  return read.kind === 'app' ? read.manifest : null
}

/** What an app asks of the host outside integrations and storage (§6). */
export const appHostAccessSchema = z.object({
  /** It has host functions: its own code runs on the host. */
  functions: z.boolean(),
  /** Its integration writes run without asking. */
  writes: z.boolean().default(false),
  network: appNetworkSchema,
  files: z.object({ read: appFilePathsSchema, write: appFilePathsSchema }),
})
export type AppHostAccess = z.infer<typeof appHostAccessSchema>

/**
 * The owner's decision (§6): the host access they allowed, and the host code
 * they allowed it for. `serverHash` names the server module as it was then;
 * changed host code is other code, and asks again. Null when the app had none.
 */
export const appAllowedHostAccessSchema = z.object({
  access: appHostAccessSchema,
  serverHash: z.string().nullable(),
})
export type AppAllowedHostAccess = z.infer<typeof appAllowedHostAccessSchema>

/** What rides a work's meta for an app: what the host's owner allowed. Everything the app declares is in its page. */
export const appMetaSchema = z.object({
  allowed: appAllowedHostAccessSchema.optional(),
})
export type AppMeta = z.infer<typeof appMetaSchema>

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

/** What a client needs to run an app's frame and show its header: nothing of the page, which the client has as the work's content. */
export interface AppState {
  roles: AppRoleState[]
  permissions: AppPermissions
  hostAccess: AppHostAccessView
  /** The network hosts in force: the app's own, once the owner allowed them. */
  network: string[]
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
  if (access.writes) clauses.push('change data through your integrations without asking')
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

/** A manifest's sources as one text, each file under a line that names it; empty when it carries none. */
export function appSourceText(manifest: AppManifest): string {
  return Object.entries(manifest.sources ?? {}).map(([path, text]) => `--- ${path} ---\n${text}`).join('\n\n')
}
