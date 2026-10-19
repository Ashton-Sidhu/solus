import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import type { Integration } from '@solus/contracts/integration-types'
import {
  MCP_APP_MAX_DATA_BYTES,
  MCP_APP_MAX_HTML_BYTES,
  mcpAppCspSchema,
  mcpAppSnapshotSchema,
  mcpAppToolMetadataSchema,
  type McpAppCallRequest,
  type McpAppReference,
  type McpAppRequest,
  type McpAppResourceRequest,
  type McpAppSnapshot,
  type McpAppToolInfo,
  type McpAppToolRequest,
} from '@solus/contracts/mcp-apps'
import type { SessionRuntime } from '../execution/session-runtime'
import type { HandlerCtx } from '../transport/server'
import { recordScopeOf } from '../admission/principal'
import { ownerKeyOf } from '../admission/actor'
import { activityFor } from '../data/activity/activity'
import { writeAssetBytes } from '../data/assets/assets'
import { storedAssetPath } from '../data/assets/asset-paths'
import type { IntegrationAppCapture, IntegrationGateway } from './gateway'

const APP_MIME_TYPE = 'text/html;profile=mcp-app'
const APP_UNAVAILABLE = 'This app is no longer available.'
/** The agent waits for its tool result while the app is saved, so a capture waits less than a call. */
const CAPTURE_TIMEOUT_MS = 15_000

const resourceMetadataSchema = z.object({ ui: z.object({ csp: mcpAppCspSchema.optional() }).optional() })
const argumentsSchema = z.record(z.string(), z.json())

/** A saved app and the caller's own integration that it runs on. */
interface OwnedApp {
  app: McpAppReference
  integration: Integration
}

/**
 * MCP Apps (docs/plans/conversation-card-parity.md): captures an app's UI once,
 * as an immutable asset that a session activity names; every client later reads
 * the same app. A host call from the app rechecks the caller's own integration
 * and the tool's current hints.
 */
export class IntegrationApps {
  constructor(
    private readonly gateway: IntegrationGateway,
    private readonly runtime: Pick<SessionRuntime, 'recordActivity' | 'actorOfSession'>,
  ) {}

  async capture(call: IntegrationAppCapture): Promise<void> {
    const metadata = mcpAppToolMetadataSchema.safeParse(call.tool._meta)
    if (!metadata.success) return
    const resourceUri = metadata.data.ui?.resourceUri ?? metadata.data['ui/resourceUri']
    const sessionId = call.context.sessionId()
    const actor = sessionId ? this.runtime.actorOfSession(sessionId) : undefined
    const signal = call.context.abortSignal
    if (!resourceUri || !sessionId || !actor || signal.aborted) return
    const resource = await this.gateway.readAppResource(call.integration.id, resourceUri, { signal, timeout: CAPTURE_TIMEOUT_MS })
    if (signal.aborted) return
    const snapshot = appSnapshot(resource, resourceUri, call)
    if (!snapshot) return
    const asset = await writeAssetBytes(Buffer.from(JSON.stringify(snapshot)), 'json')
    await this.runtime.recordActivity({ kind: 'session', id: sessionId }, actor, {
      kind: 'mcp_app',
      app: {
        integrationId: call.integration.id,
        title: `${call.integration.name} · ${call.tool.title ?? call.tool.name}`.slice(0, 256),
        tool: call.tool.name,
        resourceUri,
        assetId: asset.id,
      },
    })
  }

  /** The saved app. It needs no connection to the integration. */
  async read(request: McpAppRequest, ctx: HandlerCtx): Promise<McpAppSnapshot> {
    const app = await this.reference(request, ctx)
    let saved: string
    try {
      saved = await readFile(storedAssetPath(app.assetId), 'utf8')
    } catch {
      // The error names the host path; the client only learns the app is gone.
      throw new Error(APP_UNAVAILABLE)
    }
    return mcpAppSnapshotSchema.parse(JSON.parse(saved))
  }

  async toolInfo(request: McpAppToolRequest, ctx: HandlerCtx): Promise<McpAppToolInfo> {
    return this.describeTool(await this.ownedApp(request, ctx), request.name, ctx)
  }

  async callTool(request: McpAppCallRequest, ctx: HandlerCtx): Promise<string> {
    const owned = await this.ownedApp(request, ctx)
    const tool = await this.describeTool(owned, request.name, ctx)
    if (!tool.callable) throw new Error('This app cannot call that tool.')
    if (!tool.readOnly && !request.approved) throw new Error('This tool needs your approval.')
    const input = argumentsSchema.parse(JSON.parse(request.argumentsJson))
    return boundedJson(await this.gateway.callAppTool(owned.app.integrationId, request.name, input))
  }

  async readResource(request: McpAppResourceRequest, ctx: HandlerCtx): Promise<string> {
    const { app } = await this.ownedApp(request, ctx)
    return boundedJson(await this.gateway.readAppResource(app.integrationId, request.uri))
  }

  /** The app of one activity of the requested session, in the caller's scope. */
  private async reference(request: McpAppRequest, ctx: HandlerCtx): Promise<McpAppReference> {
    const activity = (await activityFor(recordScopeOf(ctx.principal), { kind: 'session', id: request.sessionId }))
      .find((entry) => entry.id === request.activityId)
    if (activity?.kind !== 'mcp_app') throw new Error(APP_UNAVAILABLE)
    return activity.app
  }

  /** An app runs only on the caller's own integration, never on another person's connection. */
  private async ownedApp(request: McpAppRequest, ctx: HandlerCtx): Promise<OwnedApp> {
    const app = await this.reference(request, ctx)
    const integration = this.gateway.store.get(app.integrationId, recordScopeOf(ctx.principal))
    if (!integration || integration.ownerKey !== ownerKeyOf(ctx.actor)) throw new Error('Connect this app with your own MCP account before using it.')
    return { app, integration }
  }

  /** The tool as the integration lists it now: turned off, model-only, and write tools are checked on every call. */
  private async describeTool({ app, integration }: OwnedApp, name: string, ctx: HandlerCtx): Promise<McpAppToolInfo> {
    const tool = (await this.gateway.toolsFor(app.integrationId, ownerKeyOf(ctx.actor))).find((entry) => entry.name === name)
    const metadata = mcpAppToolMetadataSchema.safeParse(tool?._meta ?? {})
    const visibility = metadata.success ? metadata.data.ui?.visibility : undefined
    return {
      callable: !!tool && metadata.success && !integration.disabledTools.includes(name) && (!visibility || visibility.includes('app')),
      readOnly: tool?.annotations?.readOnlyHint === true,
      title: tool?.title ?? name,
    }
  }
}

/** The app document of a resource read, with the call's data; null when it is not an MCP App or is too large. */
function appSnapshot(resource: ReadResourceResult, resourceUri: string, call: IntegrationAppCapture): McpAppSnapshot | null {
  const document = resource.contents.find((entry) => entry.uri === resourceUri && entry.mimeType?.replace(/\s/g, '').toLowerCase() === APP_MIME_TYPE)
  if (!document) return null
  // Base64 is 4/3 of its bytes: refuse a large blob before it is decoded.
  if ('blob' in document && document.blob.length > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4) return null
  const html = 'text' in document ? document.text : Buffer.from(document.blob, 'base64').toString('utf8')
  if (!html.trim() || Buffer.byteLength(html) > MCP_APP_MAX_HTML_BYTES) return null
  const toolInputJson = JSON.stringify(call.input)
  const toolResultJson = JSON.stringify(call.result)
  if (Buffer.byteLength(toolInputJson) > MCP_APP_MAX_DATA_BYTES || Buffer.byteLength(toolResultJson) > MCP_APP_MAX_DATA_BYTES) return null
  const metadata = resourceMetadataSchema.safeParse(document._meta)
  const csp = (metadata.success ? metadata.data.ui?.csp : undefined) ?? {}
  return mcpAppSnapshotSchema.parse({ html, toolInputJson, toolResultJson, csp })
}

/** A host result as JSON for the app, refused over the data limit. */
function boundedJson(result: ReadResourceResult | Awaited<ReturnType<IntegrationGateway['callAppTool']>>): string {
  const json = JSON.stringify(result)
  if (Buffer.byteLength(json) > MCP_APP_MAX_DATA_BYTES) throw new Error('This app result is too large to display.')
  return json
}
