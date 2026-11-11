import { z } from 'zod'
import { MCP_APP_MAX_DATA_BYTES, type McpAppCsp } from './mcp-apps'

/**
 * Apps (docs/plans/apps.md): a work of type `app` whose content is one React
 * component. The component reaches an integration through
 * `tools.<slug>.<tool>(...)`; every call leaves the frame as data and runs
 * through the gateway with the viewer's own connection.
 */

const APP_TOOL_NAME_SEPARATOR = '/'

/** `<slug>/<tool>`, the name the frame puts on the wire. */
export const appToolNameSchema = z.string().min(3).max(512).regex(/^[^/\s]+\/[^\s]+$/)

/**
 * The app's own ceiling under the gateway's (§5). `tools` names what it may
 * call; `writes` whether a write asks first. It can narrow what the viewer's
 * integrations allow, never widen it.
 */
export const appPermissionsSchema = z.object({
  tools: z.union([z.literal('all'), z.literal('read-only'), z.object({ selected: z.array(appToolNameSchema).max(256) })]),
  writes: z.enum(['ask', 'allow']),
})
export type AppPermissions = z.infer<typeof appPermissionsSchema>

export const DEFAULT_APP_PERMISSIONS: AppPermissions = { tools: 'all', writes: 'ask' }

/** What rides a work's meta for an app: its permissions. Its roles are read from the source. */
export const appMetaSchema = z.object({
  permissions: appPermissionsSchema,
})
export type AppMeta = z.infer<typeof appMetaSchema>

/** One integration the component names (the slug in `tools.<slug>.<tool>`), as the viewer sees it. */
export interface AppRoleState {
  slug: string
  /** The name of the viewer's integration with that slug; null when they have none. */
  name: string | null
  connected: boolean
}

/** What a client gets to show an app: the composed document and the facts its header shows. */
export interface AppSnapshot {
  html: string
  csp: McpAppCsp
  title: string
  roles: AppRoleState[]
  permissions: AppPermissions
  contentVersion: number
}

export const appRequestSchema = z.object({ workId: z.string().min(1) })
export type AppRequest = z.infer<typeof appRequestSchema>

export const appToolRequestSchema = appRequestSchema.extend({ name: appToolNameSchema })
export type AppToolRequest = z.infer<typeof appToolRequestSchema>

export const appCallRequestSchema = appToolRequestSchema.extend({
  argumentsJson: z.string().max(MCP_APP_MAX_DATA_BYTES),
  approved: z.boolean(),
})
export type AppCallRequest = z.infer<typeof appCallRequestSchema>

export const appPermissionsUpdateSchema = appRequestSchema.extend({ permissions: appPermissionsSchema })
export type AppPermissionsUpdate = z.infer<typeof appPermissionsUpdateSchema>

/** The slug and the tool of a wire name, or null when it is not one. */
export function parseAppToolName(name: string): { slug: string; tool: string } | null {
  const at = name.indexOf(APP_TOOL_NAME_SEPARATOR)
  if (at <= 0 || at === name.length - 1) return null
  return { slug: name.slice(0, at), tool: name.slice(at + 1) }
}

/** A one-line reading of the permissions, for a header. */
export function describeAppPermissions(permissions: AppPermissions): string {
  const tools = permissions.tools === 'all' ? 'All tools' : permissions.tools === 'read-only' ? 'Read-only tools' : `${permissions.tools.selected.length} selected tools`
  return `${tools} · writes ${permissions.writes === 'ask' ? 'ask first' : 'run on click'}`
}
