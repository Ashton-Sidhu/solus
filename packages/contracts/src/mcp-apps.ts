import { z } from 'zod'

export const MCP_APP_PROTOCOL_VERSION = '2026-01-26'
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024
export const MCP_APP_MAX_DATA_BYTES = 1024 * 1024
/** The text an app may give the agent. The agent gets it with every turn, so it stays small. */
export const MCP_APP_MAX_MODEL_CONTEXT_CHARS = 8_000

const appResourceUri = z.string().startsWith('ui://').max(4096)

/** An origin list; a malformed list is dropped, so it can never widen the policy. */
const domains = z
  .array(z.string().max(256).regex(/^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i))
  .max(32)
  .optional()
  .catch(undefined)

/** The `_meta` of a tool that declares an app (`ui.resourceUri`, or the legacy `ui/resourceUri`). */
export const mcpAppToolMetadataSchema = z.object({
  ui: z.object({
    resourceUri: appResourceUri.optional(),
    visibility: z.array(z.string()).optional(),
  }).optional(),
  'ui/resourceUri': appResourceUri.optional(),
})

export const mcpAppCspSchema = z.object({
  resourceDomains: domains,
  connectDomains: domains,
  frameDomains: domains,
  baseUriDomains: domains,
})
export type McpAppCsp = z.infer<typeof mcpAppCspSchema>

export const MCP_APP_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const
export type McpAppPermission = (typeof MCP_APP_PERMISSIONS)[number]

const requested = z.object({}).optional().catch(undefined)
/** The browser features an app asks for. A client grants one only after the person approves it. */
export const mcpAppPermissionsSchema = z.object({
  camera: requested,
  microphone: requested,
  geolocation: requested,
  clipboardWrite: requested,
})
export type McpAppPermissions = z.infer<typeof mcpAppPermissionsSchema>

const appReferenceFields = {
  title: z.string().max(256),
  tool: z.string().max(256),
  resourceUri: appResourceUri,
  assetId: z.string().min(1),
  /** The tool call that showed the app. A live app card takes the saved app by it. Absent in an app saved before Solus kept it. */
  toolUseId: z.string().min(1).max(256).optional(),
}

/**
 * What a session activity stores. HTML and tool data are loaded only when the
 * app is shown. An app runs on a Solus integration, or on an MCP server that
 * Claude Code itself is set up with.
 */
export const mcpAppReferenceSchema = z.union([
  z.object({ integrationId: z.string().min(1), ...appReferenceFields }),
  z.object({ claudeServer: z.string().min(1).max(256), ...appReferenceFields }),
])
export type McpAppReference = z.infer<typeof mcpAppReferenceSchema>

const jsonData = z.string().max(MCP_APP_MAX_DATA_BYTES).refine((value) => {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}, 'Invalid app tool data.')

export const mcpAppSnapshotSchema = z.object({
  html: z.string().max(MCP_APP_MAX_HTML_BYTES),
  toolInputJson: jsonData,
  toolResultJson: jsonData,
  csp: mcpAppCspSchema,
  /** Absent in an app saved before Solus read them. */
  permissions: mcpAppPermissionsSchema.optional(),
  prefersBorder: z.boolean().optional(),
})
export type McpAppSnapshot = z.infer<typeof mcpAppSnapshotSchema>

export const mcpAppRequestSchema = z.object({ sessionId: z.string().min(1), activityId: z.string().min(1) })
export type McpAppRequest = z.infer<typeof mcpAppRequestSchema>

export const mcpAppToolRequestSchema = mcpAppRequestSchema.extend({ name: z.string().min(1).max(256) })
export type McpAppToolRequest = z.infer<typeof mcpAppToolRequestSchema>

export const mcpAppCallRequestSchema = mcpAppToolRequestSchema.extend({
  argumentsJson: z.string().max(MCP_APP_MAX_DATA_BYTES),
  approved: z.boolean(),
})
export type McpAppCallRequest = z.infer<typeof mcpAppCallRequestSchema>

export const mcpAppResourceRequestSchema = mcpAppRequestSchema.extend({ uri: z.string().min(1).max(4096) })
export type McpAppResourceRequest = z.infer<typeof mcpAppResourceRequestSchema>

/** The app's latest context for the agent. Empty text clears it. */
export const mcpAppModelContextRequestSchema = mcpAppRequestSchema.extend({ text: z.string().max(MCP_APP_MAX_MODEL_CONTEXT_CHARS) })
export type McpAppModelContextRequest = z.infer<typeof mcpAppModelContextRequestSchema>

/** The app of a tool call that has not ended (docs/plans/mcp-first-class.md §14.1). `toolName` is the Solus tool name `<slug>__<tool>`. */
export const mcpAppLiveRequestSchema = z.object({ sessionId: z.string().min(1), toolName: z.string().min(1).max(256) })
export type McpAppLiveRequest = z.infer<typeof mcpAppLiveRequestSchema>

/** The document of a live app card: the app's HTML and policy, without the call's data. */
export interface McpAppLiveDocument extends Omit<McpAppSnapshot, 'toolInputJson' | 'toolResultJson'> {
  title: string
}

/** Why a tool call gave its live app card no result (`ui/notifications/tool-cancelled`). */
export const MCP_APP_CANCEL_REASONS = ['stopped', 'denied', 'timeout', 'failed'] as const
export type McpAppCancelReason = (typeof MCP_APP_CANCEL_REASONS)[number]

/**
 * The Solus tool name `<slug>__<tool>` of a transcript tool call that can have
 * a live app card, or null. Claude names a Solus tool `mcp__solus__<name>`,
 * Codex `solus.<name>`. The host decides if the tool has an app.
 */
export function mcpAppLiveToolName(transcriptToolName: string | undefined): string | null {
  const name = transcriptToolName?.startsWith('mcp__solus__')
    ? transcriptToolName.slice('mcp__solus__'.length)
    : transcriptToolName?.startsWith('solus.') ? transcriptToolName.slice('solus.'.length) : null
  return name && name.indexOf('__') > 0 && name.length <= 256 ? name : null
}

export interface McpAppToolInfo {
  callable: boolean
  readOnly: boolean
  title: string
  /** Why the tool is not callable, when the person can act on it. */
  refusal?: string
}

/**
 * The app's document with its policy. Network access is limited to the app's
 * declared origins. Frames must also use an opaque sandbox origin, so the
 * document cannot read client state.
 */
export function mcpAppDocument(html: string, csp: McpAppCsp): string {
  const resources = csp.resourceDomains?.join(' ') ?? ''
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `font-src data: ${resources}`,
    `media-src data: blob: ${resources}`,
    `connect-src ${csp.connectDomains?.join(' ') || "'none'"}`,
    `frame-src ${csp.frameDomains?.join(' ') || "'none'"}`,
    "object-src 'none'",
    `base-uri ${csp.baseUriDomains?.join(' ') || "'none'"}`,
    "form-action 'none'",
  ].join('; ')
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${html}`
}
