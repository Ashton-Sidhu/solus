import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { ReadResourceResultSchema } from '@modelcontextprotocol/core'
import type { ReadResourceResult } from '@modelcontextprotocol/client'
import { integrationToolName, type Integration } from '@solus/contracts/integration-types'
import {
  MCP_APP_MAX_DATA_BYTES,
  MCP_APP_MAX_HTML_BYTES,
  mcpAppCspSchema,
  mcpAppPermissionsSchema,
  mcpAppSnapshotSchema,
  mcpAppToolMetadataSchema,
  type McpAppCallRequest,
  type McpAppLiveDocument,
  type McpAppLiveRequest,
  type McpAppModelContextRequest,
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
import { ownerKeyOf, type Actor } from '../admission/actor'
import { activityFor } from '../data/activity/activity'
import { writeAssetBytes } from '../data/assets/assets'
import { storedAssetPath } from '../data/assets/asset-paths'
import { getSessionRecord } from '../data/sessions/session-records'
import { claudeSeatOf } from '../execution/agents/claude/claude-backend'
import { claudeIntegrationToolName, deniedByClaude, type ClaudeAppPlace, type ClaudeAppProcesses, type ClaudeMcpApp } from '../execution/agents/claude/claude-mcp-apps'
import type { IntegrationAppCapture, IntegrationGateway, UpstreamTool } from './gateway'

const APP_MIME_TYPE = 'text/html;profile=mcp-app'
const APP_UNAVAILABLE = 'This app is no longer available.'
/** The agent waits for its tool result while the app is saved, so a capture waits less than a call. */
const CAPTURE_TIMEOUT_MS = 15_000
/** Live documents read for live app cards: a call of the same tool soon after reads none again. */
const LIVE_DOCUMENTS_KEPT = 16
const LIVE_DOCUMENT_TTL_MS = 5 * 60_000

const resourceMetadataSchema = z.object({
  ui: z.object({
    csp: mcpAppCspSchema.optional(),
    permissions: mcpAppPermissionsSchema.optional().catch(undefined),
    prefersBorder: z.boolean().optional().catch(undefined),
  }).optional(),
})
const argumentsSchema = z.record(z.string(), z.json())

/** A saved app and the caller's own integration that it runs on. */
interface OwnedApp {
  app: Extract<McpAppReference, { integrationId: string }>
  integration: Integration
}

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never
type AppResult = ReadResourceResult | ClaudeMcpApp['resource'] | ClaudeMcpApp['result'] | Awaited<ReturnType<IntegrationGateway['callAppTool']>>

/**
 * MCP Apps (docs/plans/conversation-card-parity.md): captures an app's UI once,
 * as an immutable asset that a session activity names; every client later reads
 * the same app. A host call from the app rechecks the caller's own integration
 * and the tool's current hints. In a Claude session it also obeys Claude's
 * permission rules, because a card's call never passes Claude's own check. An
 * app of a server Claude itself is set up with runs through a Claude process.
 */
export class IntegrationApps {
  /** The newest last; a key names the integration, the person, and the app's resource. */
  private readonly liveDocuments = new Map<string, { document: Promise<McpAppLiveDocument | null>; readAt: number }>()

  constructor(
    private readonly gateway: IntegrationGateway,
    private readonly runtime: Pick<SessionRuntime, 'recordActivity' | 'actorOfSession' | 'seatForTurn' | 'appModelContexts'>,
    private readonly claude: Pick<ClaudeAppProcesses, 'toolInfo' | 'access' | 'callTool' | 'readResource'>,
    private readonly now: () => number = Date.now,
  ) {}

  async capture(call: IntegrationAppCapture): Promise<void> {
    const metadata = mcpAppToolMetadataSchema.safeParse(call.tool._meta)
    if (!metadata.success) return
    const resourceUri = metadata.data.ui?.resourceUri ?? metadata.data['ui/resourceUri']
    const sessionId = call.context.sessionId()
    const actor = sessionId ? this.runtime.actorOfSession(sessionId) : undefined
    const signal = call.context.abortSignal
    if (!resourceUri || !sessionId || !actor || signal.aborted) return
    const resource = await this.gateway.readResource(call.integration.id, resourceUri, actor.principal, { signal, timeout: CAPTURE_TIMEOUT_MS })
    if (signal.aborted) return
    const snapshot = appSnapshot(resource, resourceUri, call)
    if (!snapshot) return
    const reference: DistributiveOmit<McpAppReference, 'assetId'> = {
      integrationId: call.integration.id,
      title: appTitle(call.integration, call.tool),
      tool: call.tool.name,
      resourceUri,
    }
    const toolUseId = call.context.parentToolUseId()
    if (toolUseId) reference.toolUseId = toolUseId
    await this.save(sessionId, actor, snapshot, reference)
  }

  /**
   * The app of a tool call that has not ended, so its card can show while the
   * call runs (docs/plans/mcp-first-class.md §14.1). Only the person whose
   * integration the call runs on gets it: the session's own person, with
   * their own integration. Null when the tool declares no app.
   */
  async liveRead({ sessionId, toolName }: McpAppLiveRequest, ctx: HandlerCtx): Promise<McpAppLiveDocument | null> {
    const ownerKey = ownerKeyOf(ctx.actor)
    const sessionActor = this.runtime.actorOfSession(sessionId)
    if (!sessionActor || ownerKeyOf(sessionActor) !== ownerKey) return null
    // A slug has no `__`, but the longest match is right even if one had.
    const integration = this.gateway.store.list(recordScopeOf(ctx.principal), ownerKey)
      .filter((entry) => entry.ownerKey === ownerKey && toolName.startsWith(`${entry.slug}__`))
      .sort((a, b) => b.slug.length - a.slug.length)[0]
    if (!integration || integration.disabledTools.some((name) => integrationToolName(integration.slug, name) === toolName)) return null
    const tool = (await this.gateway.toolsFor(integration.id, ownerKey)).find((entry) => integrationToolName(integration.slug, entry.name) === toolName)
    const metadata = mcpAppToolMetadataSchema.safeParse(tool?._meta)
    const resourceUri = metadata.success ? metadata.data.ui?.resourceUri ?? metadata.data['ui/resourceUri'] : undefined
    if (!tool || !resourceUri) return null
    const key = `${integration.id}\0${ownerKey}\0${resourceUri}`
    const kept = this.liveDocuments.get(key)
    if (kept && this.now() - kept.readAt < LIVE_DOCUMENT_TTL_MS) return kept.document
    const title = appTitle(integration, tool)
    const document = this.gateway.readResource(integration.id, resourceUri, ctx.principal, { timeout: CAPTURE_TIMEOUT_MS })
      .then((resource) => {
        const parts = appDocument(resource, resourceUri)
        return parts ? { ...parts, title } : null
      })
    this.liveDocuments.delete(key)
    this.liveDocuments.set(key, { document, readAt: this.now() })
    for (const oldest of this.liveDocuments.keys()) {
      if (this.liveDocuments.size <= LIVE_DOCUMENTS_KEPT) break
      this.liveDocuments.delete(oldest)
    }
    // A failed read is not kept: the next call reads again.
    document.catch(() => {
      if (this.liveDocuments.get(key)?.document === document) this.liveDocuments.delete(key)
    })
    return document
  }

  /** The app of a tool call that a server of Claude's own answered. */
  async captureClaude(sessionId: string, call: ClaudeMcpApp): Promise<void> {
    const actor = this.runtime.actorOfSession(sessionId)
    if (!actor) return
    const snapshot = appSnapshot(ReadResourceResultSchema.parse(call.resource), call.resourceUri, call)
    if (!snapshot) return
    await this.save(sessionId, actor, snapshot, {
      claudeServer: call.server,
      title: `${call.server} · ${call.tool.name}`.slice(0, 256),
      tool: call.tool.name,
      resourceUri: call.resourceUri,
    })
  }

  private async save(sessionId: string, actor: Actor, snapshot: McpAppSnapshot, reference: DistributiveOmit<McpAppReference, 'assetId'>): Promise<void> {
    const asset = await writeAssetBytes(Buffer.from(JSON.stringify(snapshot)), 'json')
    await this.runtime.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'mcp_app', app: { ...reference, assetId: asset.id } })
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
    const app = await this.reference(request, ctx)
    if ('claudeServer' in app) return this.claude.toolInfo(await this.claudeAppPlace(request.sessionId, ctx), app.claudeServer, request.name)
    return this.describeTool(await this.ownedApp(app, ctx), request, ctx)
  }

  async callTool(request: McpAppCallRequest, ctx: HandlerCtx): Promise<string> {
    const tool = await this.toolInfo(request, ctx)
    if (!tool.callable) throw new Error(tool.refusal ?? 'This app cannot call that tool.')
    if (!tool.readOnly && !request.approved) throw new Error('This tool needs your approval.')
    const input = argumentsSchema.parse(JSON.parse(request.argumentsJson))
    const app = await this.reference(request, ctx)
    if ('claudeServer' in app) return boundedJson(await this.claude.callTool(await this.claudeAppPlace(request.sessionId, ctx), app.claudeServer, request.name, input))
    return boundedJson(await this.gateway.callAppTool(app.integrationId, request.name, input, ctx.principal))
  }

  async readResource(request: McpAppResourceRequest, ctx: HandlerCtx): Promise<string> {
    const app = await this.reference(request, ctx)
    if ('claudeServer' in app) return boundedJson(await this.claude.readResource(await this.claudeAppPlace(request.sessionId, ctx), app.claudeServer, request.uri))
    await this.ownedApp(app, ctx)
    return boundedJson(await this.gateway.readResource(app.integrationId, request.uri, ctx.principal))
  }

  /** Keeps the app's latest context for the session's next turns, whichever provider runs them. */
  async updateModelContext(request: McpAppModelContextRequest, ctx: HandlerCtx): Promise<void> {
    const app = await this.reference(request, ctx)
    this.runtime.appModelContexts.set(request.sessionId, request.activityId, app.title, request.text)
  }

  /** The app of one activity of the requested session, in the caller's scope. */
  private async reference(request: McpAppRequest, ctx: HandlerCtx): Promise<McpAppReference> {
    const activity = (await activityFor(recordScopeOf(ctx.principal), { kind: 'session', id: request.sessionId }))
      .find((entry) => entry.id === request.activityId)
    if (activity?.kind !== 'mcp_app') throw new Error(APP_UNAVAILABLE)
    return activity.app
  }

  /** An app runs only on the caller's own integration, never on another person's connection. */
  private async ownedApp(app: Extract<McpAppReference, { integrationId: string }>, ctx: HandlerCtx): Promise<OwnedApp> {
    const integration = this.gateway.store.get(app.integrationId, recordScopeOf(ctx.principal))
    if (!integration || integration.ownerKey !== ownerKeyOf(ctx.actor)) throw new Error('Connect this app with your own MCP account before using it.')
    return { app, integration }
  }

  /** Where Claude answers for this session, and null when the session is not Claude's. */
  private async claudePlace(sessionId: string, ctx: HandlerCtx): Promise<(ClaudeAppPlace & { ownerKey: string }) | null> {
    const record = await getSessionRecord(recordScopeOf(ctx.principal), sessionId)
    if (record?.provider !== 'claude-code') return null
    const seat = await this.runtime.seatForTurn(ctx.actor, 'claude-code')
    return { cwd: record.cwd ?? record.projectPath, ownerKey: record.ownerKey, seat: seat ? claudeSeatOf(seat) : undefined }
  }

  /** A server of Claude's own runs on the login of the person it was set up for, so only that person's card reaches it. */
  private async claudeAppPlace(sessionId: string, ctx: HandlerCtx): Promise<ClaudeAppPlace> {
    const place = await this.claudePlace(sessionId, ctx)
    if (!place) throw new Error(APP_UNAVAILABLE)
    if (place.ownerKey !== ownerKeyOf(ctx.actor)) throw new Error('Only the person who ran this session can use this app.')
    return place
  }

  /** The tool as the integration lists it now: turned off, model-only, and write tools are checked on every call. */
  private async describeTool({ app, integration }: OwnedApp, { sessionId, name }: McpAppToolRequest, ctx: HandlerCtx): Promise<McpAppToolInfo> {
    const tool = (await this.gateway.toolsFor(app.integrationId, ownerKeyOf(ctx.actor))).find((entry) => entry.name === name)
    const metadata = mcpAppToolMetadataSchema.safeParse(tool?._meta ?? {})
    const visibility = metadata.success ? metadata.data.ui?.visibility : undefined
    const info: McpAppToolInfo = {
      callable: !!tool && metadata.success && !integration.disabledTools.includes(name) && (!visibility || visibility.includes('app')),
      readOnly: tool?.annotations?.readOnlyHint === true,
      title: tool?.title ?? name,
    }
    const place = info.callable ? await this.claudePlace(sessionId, ctx) : null
    if (!place) return info
    const access = await this.claude.access(place, claudeIntegrationToolName(integrationToolName(integration.slug, name)))
    if (access === 'deny') return { ...info, callable: false, refusal: deniedByClaude(info.title) }
    return access === 'ask' ? { ...info, readOnly: false } : info
  }
}

function appTitle(integration: Pick<Integration, 'name'>, tool: Pick<UpstreamTool, 'name' | 'title'>): string {
  return `${integration.name} · ${tool.title ?? tool.name}`.slice(0, 256)
}

/** The app document of a resource read, with the call's data; null when it is not an MCP App or is too large. */
function appSnapshot(resource: ReadResourceResult, resourceUri: string, call: { input: unknown; result: unknown }): McpAppSnapshot | null {
  const document = appDocument(resource, resourceUri)
  if (!document) return null
  const toolInputJson = JSON.stringify(call.input)
  const toolResultJson = JSON.stringify(call.result)
  if (Buffer.byteLength(toolInputJson) > MCP_APP_MAX_DATA_BYTES || Buffer.byteLength(toolResultJson) > MCP_APP_MAX_DATA_BYTES) return null
  return mcpAppSnapshotSchema.parse({ ...document, toolInputJson, toolResultJson })
}

/** The app's HTML and policy from a resource read; null when it is not an MCP App or is too large. */
function appDocument(resource: ReadResourceResult, resourceUri: string): Omit<McpAppSnapshot, 'toolInputJson' | 'toolResultJson'> | null {
  const document = resource.contents.find((entry) => entry.uri === resourceUri && entry.mimeType?.replace(/\s/g, '').toLowerCase() === APP_MIME_TYPE)
  if (!document) return null
  // Base64 is 4/3 of its bytes: refuse a large blob before it is decoded.
  if ('blob' in document && document.blob.length > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4) return null
  const html = 'text' in document ? document.text : Buffer.from(document.blob, 'base64').toString('utf8')
  if (!html.trim() || Buffer.byteLength(html) > MCP_APP_MAX_HTML_BYTES) return null
  const metadata = resourceMetadataSchema.safeParse(document._meta)
  const ui = metadata.success ? metadata.data.ui : undefined
  return { html, csp: ui?.csp ?? {}, permissions: ui?.permissions, prefersBorder: ui?.prefersBorder }
}

/** A host result as JSON for the app, refused over the data limit. */
function boundedJson(result: AppResult): string {
  const json = JSON.stringify(result)
  if (Buffer.byteLength(json) > MCP_APP_MAX_DATA_BYTES) throw new Error('This app result is too large to display.')
  return json
}
