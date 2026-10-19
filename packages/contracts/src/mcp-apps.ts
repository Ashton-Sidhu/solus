import { z } from 'zod'

export const MCP_APP_PROTOCOL_VERSION = '2026-01-26'
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024
export const MCP_APP_MAX_DATA_BYTES = 1024 * 1024

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
})
export type McpAppCsp = z.infer<typeof mcpAppCspSchema>

/** What a session activity stores. HTML and tool data are loaded only when the app is shown. */
export const mcpAppReferenceSchema = z.object({
  integrationId: z.string().min(1),
  title: z.string().max(256),
  tool: z.string().max(256),
  resourceUri: appResourceUri,
  assetId: z.string().min(1),
})
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

export interface McpAppToolInfo {
  callable: boolean
  readOnly: boolean
  title: string
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
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${html}`
}
