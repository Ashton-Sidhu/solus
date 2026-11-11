import { z } from 'zod'
import {
  DEFAULT_APP_PERMISSIONS,
  parseAppCallName,
  type AppCallRequest,
  type AppHostAccessDecision,
  type AppHostAccessView,
  type AppPermissionsUpdate,
  type AppRequest,
  type AppRoleState,
  type AppSnapshot,
  type AppStorageOperation,
  type AppToolRequest,
} from '@solus/contracts/apps'
import { MCP_APP_MAX_DATA_BYTES, type McpAppToolInfo } from '@solus/contracts/mcp-apps'
import type { Integration } from '@solus/contracts/integration-types'
import type { HandlerCtx } from '../transport/server'
import { isHostOwner, recordScopeOf } from '../admission/principal'
import { ownerKeyOf } from '../admission/actor'
import { Work } from '../data/works/work'
import type { IntegrationGateway } from '../integrations/gateway'
import type { IntegrationStore } from '../integrations/integration-store'
import { appClientModule, appRoles, appServerModule, readAppContent, type AppContent } from './app-content'
import type { AppFunctions } from './app-functions'
import { admits, appConnectDomains, hostAccessAsked, hostAccessCovers, hostAccessIsEmpty } from './app-permissions'
import { composeAppDocument, loadAppShell } from './app-shell'
import type { AppStorage, StoredValue } from './app-storage'

const APP_UNAVAILABLE = 'This app is not available.'

const argumentsSchema = z.record(z.string(), z.json())
type CallArguments = z.infer<typeof argumentsSchema>

const storageKeySchema = z.object({ key: z.string() })
const storageSetSchema = storageKeySchema.extend({ value: z.json() })

/** The `tools/call` result the frame's bridge reads a value from. */
function valueResult(value: StoredValue) {
  return { structuredContent: { value } }
}

/** What a call answers: an integration tool's own result, or a value of the app's storage or host functions. */
type CallResult = Awaited<ReturnType<IntegrationGateway['callAppTool']>> | ReturnType<typeof valueResult>

/** What a call does once it may run. */
type CallRun = (input: CallArguments) => Promise<CallResult>

interface ResolvedCall {
  info: McpAppToolInfo
  /** Set only when the call is callable. */
  run: CallRun | null
}

function refused(title: string, refusal?: string): ResolvedCall {
  const info: McpAppToolInfo = { callable: false, readOnly: false, title }
  if (refusal) info.refusal = refusal
  return { info, run: null }
}

/**
 * Apps (docs/plans/apps.md §7): an `app` work's document, and the calls its
 * frame makes. Every call loads the work in the caller's scope and is checked
 * on every call: an integration tool against the caller's own integration and
 * the app's permissions, a host function against the host access the host's
 * owner allowed.
 */
export class Apps {
  /** A bundle is megabytes of JSON, so its parsed content is kept for the revision it was read from. */
  private readonly contents = new Map<string, { contentVersion: number; content: AppContent }>()

  constructor(
    private readonly gateway: Pick<IntegrationGateway, 'callAppTool' | 'toolsFor' | 'connectionStatus'>,
    private readonly store: Pick<IntegrationStore, 'getBySlug'>,
    private readonly storage: AppStorage,
    private readonly functions: AppFunctions,
  ) {}

  async read(request: AppRequest, ctx: HandlerCtx): Promise<AppSnapshot> {
    return this.snapshot(await this.app(request, ctx), ctx)
  }

  async permissionsUpdate(request: AppPermissionsUpdate, ctx: HandlerCtx): Promise<AppSnapshot> {
    const work = await this.app(request, ctx)
    await work.setAppPermissions(request.permissions)
    return this.snapshot(work, ctx)
  }

  /** The host's owner allows what the app asks of the host now, or revokes what was allowed (§6). */
  async hostAccessDecide(request: AppHostAccessDecision, ctx: HandlerCtx): Promise<AppSnapshot> {
    if (!isHostOwner(ctx.principal)) throw new Error('Only the owner of this host can allow or revoke an app\'s host access.')
    const work = await this.app(request, ctx)
    await work.setAppAllowed(request.allow ? this.hostAccess(work, ctx).asks : null)
    // A runner started under the old decision must not answer under the new one.
    this.functions.stop(work.id)
    return this.snapshot(work, ctx)
  }

  async toolInfo(request: AppToolRequest, ctx: HandlerCtx): Promise<McpAppToolInfo> {
    return (await this.resolveCall(await this.app(request, ctx), request.name, ctx)).info
  }

  async callTool(request: AppCallRequest, ctx: HandlerCtx): Promise<string> {
    const { info, run } = await this.resolveCall(await this.app(request, ctx), request.name, ctx)
    if (!info.callable || !run) throw new Error(info.refusal ?? `This app cannot call ${request.name}.`)
    if (!info.readOnly && !request.approved) throw new Error('This tool needs your approval.')
    const json = JSON.stringify(await run(argumentsSchema.parse(JSON.parse(request.argumentsJson))))
    if (Buffer.byteLength(json) > MCP_APP_MAX_DATA_BYTES) throw new Error('This result is too large to display.')
    return json
  }

  /** A deleted work: its runner stops and everything it kept on this host goes. */
  async forget(workId: string): Promise<void> {
    this.functions.stop(workId)
    this.contents.delete(workId)
    await this.storage.remove(workId)
  }

  /** The work, in the caller's scope: another person's id does not resolve. */
  private async app(request: AppRequest, ctx: HandlerCtx): Promise<Work> {
    const work = await Work.find(recordScopeOf(ctx.principal), request.workId)
    if (!work || work.type !== 'app') throw new Error(APP_UNAVAILABLE)
    return work
  }

  private contentOf(work: Work): AppContent {
    const kept = this.contents.get(work.id)
    if (kept?.contentVersion === work.contentVersion) return kept.content
    const content = readAppContent(work.content)
    this.contents.set(work.id, { contentVersion: work.contentVersion, content })
    return content
  }

  private hostAccess(work: Work, ctx: HandlerCtx): AppHostAccessView {
    const asks = hostAccessAsked(work.app?.permissions ?? DEFAULT_APP_PERMISSIONS, appServerModule(this.contentOf(work)) !== null)
    const allowed = work.app?.allowed
    const state = hostAccessIsEmpty(asks) ? 'none' : allowed && hostAccessCovers(allowed, asks) ? 'allowed' : 'pending'
    return { asks, state, canDecide: isHostOwner(ctx.principal) }
  }

  private async snapshot(work: Work, ctx: HandlerCtx): Promise<AppSnapshot> {
    const content = this.contentOf(work)
    const permissions = work.app?.permissions ?? DEFAULT_APP_PERMISSIONS
    const roles = await this.roles(content, ctx)
    const hostAccess = this.hostAccess(work, ctx)
    const html = composeAppDocument({
      shell: await loadAppShell(),
      clientModule: appClientModule(content),
      css: content.kind === 'bundle' ? content.bundle.css : undefined,
      roles,
      permissions,
      hostAccess: hostAccess.state,
    })
    // The frame has no network until the owner allowed the app's hosts.
    const csp = hostAccess.state === 'allowed' && hostAccess.asks.network.length > 0 ? { connectDomains: appConnectDomains(hostAccess.asks.network) } : {}
    return { html, csp, title: work.title, roles, permissions, hostAccess, contentVersion: work.contentVersion }
  }

  /** Each role as the caller sees it: whether they own an integration with that slug, and whether it is connected. */
  private async roles(content: AppContent, ctx: HandlerCtx): Promise<AppRoleState[]> {
    return Promise.all(appRoles(content).map(async (slug) => {
      const integration = this.integrationFor(slug, ctx)
      if (!integration) return { slug, name: null, connected: false }
      const status = await this.gateway.connectionStatus(integration.id)
      return { slug, name: integration.name, connected: status.status === 'connected' }
    }))
  }

  /** The caller's own integration with a slug; null when they have none. */
  private integrationFor(slug: string, ctx: HandlerCtx): Integration | null {
    return this.store.getBySlug(slug, recordScopeOf(ctx.principal), ownerKeyOf(ctx.actor))
  }

  /** What a call name addresses as things stand now, and how it runs when it may. */
  private async resolveCall(work: Work, name: string, ctx: HandlerCtx): Promise<ResolvedCall> {
    const call = parseAppCallName(name)
    if (!call) return refused(name)
    if (call.kind === 'tool') return this.resolveTool(work, name, call.slug, call.tool, ctx)
    if (call.kind === 'storage') {
      return { info: { callable: true, readOnly: true, title: `Storage ${call.operation}` }, run: (input) => this.runStorage(work.id, call.operation, input) }
    }
    return this.resolveFunction(work, call.name, ctx)
  }

  /**
   * An integration tool: the role in the app, the caller's own integration,
   * its hints, the owner's disabled list, and the app's permissions.
   */
  private async resolveTool(work: Work, name: string, slug: string, toolName: string, ctx: HandlerCtx): Promise<ResolvedCall> {
    if (!appRoles(this.contentOf(work)).includes(slug)) return refused(toolName)
    const integration = this.integrationFor(slug, ctx)
    if (!integration) return refused(toolName, `Connect ${slug} in Settings → MCP to use this app.`)
    const tool = (await this.gateway.toolsFor(integration.id, ownerKeyOf(ctx.actor))).find((entry) => entry.name === toolName)
    if (!tool) return refused(toolName)
    if (integration.disabledTools.includes(toolName)) return refused(toolName, `The ${toolName} tool of ${integration.name} is turned off in Settings → MCP.`)
    const permissions = work.app?.permissions ?? DEFAULT_APP_PERMISSIONS
    if (!admits(permissions, name, tool)) return refused(tool.title ?? toolName, `This app's permissions do not allow ${tool.title ?? toolName}.`)
    return {
      info: { callable: true, readOnly: tool.annotations?.readOnlyHint === true || permissions.writes === 'allow', title: tool.title ?? toolName },
      run: (input) => this.gateway.callAppTool(integration.id, toolName, input),
    }
  }

  /**
   * A host function (§6): the app has a server module, the host's owner
   * allowed its host access, and the caller is that owner. It never asks on a
   * call: the owner allowed the host access as a whole.
   */
  private resolveFunction(work: Work, functionName: string, ctx: HandlerCtx): ResolvedCall {
    const server = appServerModule(this.contentOf(work))
    if (server === null) return refused(functionName, 'This app has no host functions.')
    const hostAccess = this.hostAccess(work, ctx)
    if (!hostAccess.canDecide) return refused(functionName, 'This app runs code on its host. Only the owner of the host can run it.')
    if (hostAccess.state !== 'allowed') return refused(functionName, 'This app waits for its host access. Allow it in the app\'s header, then try again.')
    return {
      info: { callable: true, readOnly: true, title: functionName },
      run: async (input) => valueResult(await this.functions.call({
        workId: work.id,
        contentVersion: work.contentVersion,
        server,
        access: hostAccess.asks,
        dataFolder: await this.storage.functionsFolder(work.id),
      }, functionName, input)),
    }
  }

  private async runStorage(workId: string, operation: AppStorageOperation, input: CallArguments): Promise<CallResult> {
    switch (operation) {
      case 'get':
        return valueResult(await this.storage.get(workId, storageKeySchema.parse(input).key))
      case 'keys':
        return valueResult(await this.storage.keys(workId))
      case 'set': {
        const { key, value } = storageSetSchema.parse(input)
        await this.storage.set(workId, key, value)
        return valueResult(null)
      }
      case 'delete':
        await this.storage.delete(workId, storageKeySchema.parse(input).key)
        return valueResult(null)
    }
  }
}
