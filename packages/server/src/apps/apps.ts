import { z } from 'zod'
import {
  appManifestOf,
  parseAppCallName,
  type AppCallRequest,
  type AppHostAccessDecision,
  type AppHostAccessView,
  type AppManifest,
  type AppRequest,
  type AppRoleState,
  type AppState,
  type AppStorageOperation,
  type AppToolRequest,
} from '@solus/contracts/apps'
import { MCP_APP_MAX_DATA_BYTES, type McpAppToolInfo } from '@solus/contracts/mcp-apps'
import type { Integration } from '@solus/contracts/integration-types'
import type { HandlerCtx } from '../transport/server'
import { isHostOwner, recordScopeOf, type Principal } from '../admission/principal'
import { ownerKeyOf } from '../admission/actor'
import type { AppPreviewArguments, AppPreviewHost, AppPreviewValue } from '../data/works/artifact-preview'
import { Work } from '../data/works/work'
import type { IntegrationGateway } from '../integrations/gateway'
import type { IntegrationStore } from '../integrations/integration-store'
import { appServerHash } from './app-content'
import type { AppFunctions } from './app-functions'
import { admits, hostAccessAsked, hostAccessState } from './app-permissions'
import type { AppStorage, StoredValue } from './app-storage'

const APP_UNAVAILABLE = 'This app is not available.'

const argumentsSchema = z.record(z.string(), z.json())
type CallArguments = z.infer<typeof argumentsSchema>

const storageKeySchema = z.object({ key: z.string() })
const storageSetSchema = storageKeySchema.extend({ value: z.json() })

/** The result the page's host reads a value from. */
function valueResult(value: StoredValue) {
  return { structuredContent: { value } }
}

/** What a call answers: an integration tool's own result, or a value of the app's storage or host functions. */
type CallResult = Awaited<ReturnType<IntegrationGateway['callAppTool']>> | ReturnType<typeof valueResult>

/** One revision of an app as it was read: its manifest, and the name of its host code. */
interface AppRevision {
  contentVersion: number
  manifest: AppManifest
  serverHash: string | null
}

/** An app as a call sees it: the work, and the revision of its page. */
interface App {
  work: Work
  manifest: AppManifest
  serverHash: string | null
}

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
 * Apps (docs/plans/apps.md §7): the calls the page of an app makes, and its
 * host access. An app is an `artifact` work whose page has an app manifest.
 * Every call loads the work in the caller's scope and is checked on every
 * call: an integration tool against the caller's own integration and the
 * app's permissions, a host function against the host access the host's
 * owner allowed.
 */
export class Apps {
  /** A page is megabytes of text, so its manifest and the hash of its host code are kept for the revision they were read from. */
  private readonly revisions = new Map<string, AppRevision>()

  constructor(
    private readonly gateway: Pick<IntegrationGateway, 'callAppTool' | 'toolsFor' | 'connectionStatus'>,
    private readonly store: Pick<IntegrationStore, 'getBySlug'>,
    private readonly storage: AppStorage,
    private readonly functions: AppFunctions,
  ) {}

  async read(request: AppRequest, ctx: HandlerCtx): Promise<AppState> {
    return this.state(await this.app(request, ctx), ctx)
  }

  /** The host's owner allows what the app asks of the host now, or revokes what was allowed (§6). */
  async hostAccessDecide(request: AppHostAccessDecision, ctx: HandlerCtx): Promise<AppState> {
    if (!isHostOwner(ctx.principal)) throw new Error('Only the owner of this host can allow or revoke an app\'s host access.')
    const app = await this.app(request, ctx)
    await app.work.setAppAllowed(request.allow ? { access: this.hostAccess(app, ctx).asks, serverHash: app.serverHash } : null)
    // A runner started under the old decision must not answer under the new one.
    this.functions.stop(app.work.id)
    return this.state(app, ctx)
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

  /**
   * What answers an app page's calls while an agent previews it (§7); null
   * when the page is not an app. A preview shows the agent its own work, so it
   * changes nothing: storage is read from the saved app and written to memory,
   * an integration is not called, and a host function runs only when the
   * host's owner already allowed this code for the saved app.
   */
  async previewHost(html: string, workId: string | undefined, principal: Principal): Promise<AppPreviewHost | null> {
    const manifest = appManifestOf(html)
    if (!manifest) return null
    const saved = workId ? await Work.find(recordScopeOf(principal), workId) : null
    const asks = hostAccessAsked(manifest.permissions, manifest.server !== undefined)
    const isAllowed = hostAccessState(asks, appServerHash(manifest), saved?.app?.allowed) === 'allowed'
    // The host's own run acts for its owner.
    const mayRunFunctions = isAllowed && (principal.kind === 'system' || isHostOwner(principal))
    const written = new Map<string, AppPreviewValue>()
    const call = async (name: string, input: AppPreviewArguments): Promise<AppPreviewValue> => {
      const named = parseAppCallName(name)
      if (named?.kind === 'storage') {
        if (named.operation === 'set') written.set(storageSetSchema.parse(input).key, storageSetSchema.parse(input).value)
        if (named.operation === 'delete') written.set(storageKeySchema.parse(input).key, null)
        if (named.operation === 'keys') return [...new Set([...(saved ? await this.storage.keys(saved.id) : []), ...written.keys()])].filter((key) => written.get(key) !== null)
        if (named.operation !== 'get') return null
        const { key } = storageKeySchema.parse(input)
        return written.has(key) ? written.get(key) ?? null : saved ? this.storage.get(saved.id, key) : null
      }
      if (named?.kind === 'function') {
        if (!saved || !manifest.server || !mayRunFunctions) throw new Error('A preview runs a host function only after the owner of the host allowed this code for the saved app. Save the app, ask the user to allow it, and preview with work_id.')
        return this.functions.call({ workId: saved.id, contentVersion: saved.contentVersion, server: manifest.server, access: asks, dataFolder: await this.storage.functionsFolder(saved.id) }, named.name, input)
      }
      throw new Error(named ? 'A preview does not call an integration.' : `A preview cannot call ${name}.`)
    }
    return { network: isAllowed ? asks.network : [], call }
  }

  /** A deleted work: its runner stops and everything it kept on this host goes. */
  async forget(workId: string): Promise<void> {
    this.functions.stop(workId)
    this.revisions.delete(workId)
    await this.storage.remove(workId)
  }

  /** The app, in the caller's scope: another person's id does not resolve, and an artifact with no manifest is not an app. */
  private async app(request: AppRequest, ctx: HandlerCtx): Promise<App> {
    const work = await Work.find(recordScopeOf(ctx.principal), request.workId)
    if (!work || work.type !== 'artifact') throw new Error(APP_UNAVAILABLE)
    const kept = this.revisions.get(work.id)
    if (kept?.contentVersion === work.contentVersion) return { work, manifest: kept.manifest, serverHash: kept.serverHash }
    const manifest = appManifestOf(work.content)
    if (!manifest) throw new Error(APP_UNAVAILABLE)
    const revision = { contentVersion: work.contentVersion, manifest, serverHash: appServerHash(manifest) }
    this.revisions.set(work.id, revision)
    return { work, manifest, serverHash: revision.serverHash }
  }

  private hostAccess(app: App, ctx: HandlerCtx): AppHostAccessView {
    const asks = hostAccessAsked(app.manifest.permissions, app.manifest.server !== undefined)
    return { asks, state: hostAccessState(asks, app.serverHash, app.work.app?.allowed), canDecide: isHostOwner(ctx.principal) }
  }

  private async state(app: App, ctx: HandlerCtx): Promise<AppState> {
    const hostAccess = this.hostAccess(app, ctx)
    return {
      roles: await this.roles(app.manifest, ctx),
      permissions: app.manifest.permissions,
      hostAccess,
      // The page has no network until the owner allowed the app's hosts.
      network: hostAccess.state === 'allowed' ? hostAccess.asks.network : [],
      contentVersion: app.work.contentVersion,
    }
  }

  /** Each role as the caller sees it: whether they own an integration with that slug, and whether it is connected. */
  private async roles(manifest: AppManifest, ctx: HandlerCtx): Promise<AppRoleState[]> {
    return Promise.all(manifest.integrations.map(async (slug) => {
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
  private async resolveCall(app: App, name: string, ctx: HandlerCtx): Promise<ResolvedCall> {
    const call = parseAppCallName(name)
    if (!call) return refused(name)
    if (call.kind === 'tool') return this.resolveTool(app, name, call.slug, call.tool, ctx)
    if (call.kind === 'storage') {
      return { info: { callable: true, readOnly: true, title: `Storage ${call.operation}` }, run: (input) => this.runStorage(app.work.id, call.operation, input) }
    }
    return this.resolveFunction(app, call.name, ctx)
  }

  /**
   * An integration tool: the role in the app, the caller's own integration,
   * its hints, the owner's disabled list, and the app's permissions. A write
   * asks the person, unless the app declares that writes run and the host's
   * owner allowed that.
   */
  private async resolveTool(app: App, name: string, slug: string, toolName: string, ctx: HandlerCtx): Promise<ResolvedCall> {
    if (!app.manifest.integrations.includes(slug)) return refused(toolName)
    const integration = this.integrationFor(slug, ctx)
    if (!integration) return refused(toolName, `Connect ${slug} in Settings → MCP to use this app.`)
    const tool = (await this.gateway.toolsFor(integration.id, ownerKeyOf(ctx.actor))).find((entry) => entry.name === toolName)
    if (!tool) return refused(toolName)
    if (integration.disabledTools.includes(toolName)) return refused(toolName, `The ${toolName} tool of ${integration.name} is turned off in Settings → MCP.`)
    if (!admits(app.manifest.permissions, name, tool)) return refused(tool.title ?? toolName, `This app's permissions do not allow ${tool.title ?? toolName}.`)
    const writesRun = app.manifest.permissions.writes === 'allow' && this.hostAccess(app, ctx).state === 'allowed'
    return {
      info: { callable: true, readOnly: tool.annotations?.readOnlyHint === true || writesRun, title: tool.title ?? toolName },
      run: (input) => this.gateway.callAppTool(integration.id, toolName, input),
    }
  }

  /**
   * A host function (§6): the app has a server module, the host's owner
   * allowed its host access, and the caller is that owner. It never asks on a
   * call: the owner allowed the host access as a whole.
   */
  private resolveFunction(app: App, functionName: string, ctx: HandlerCtx): ResolvedCall {
    const { server } = app.manifest
    if (server === undefined) return refused(functionName, 'This app has no host functions.')
    const hostAccess = this.hostAccess(app, ctx)
    if (!hostAccess.canDecide) return refused(functionName, 'This app runs code on its host. Only the owner of the host can run it.')
    if (hostAccess.state !== 'allowed') return refused(functionName, 'This app waits for its host access. Allow it in the app\'s header, then try again.')
    return {
      info: { callable: true, readOnly: true, title: functionName },
      run: async (input) => valueResult(await this.functions.call({
        workId: app.work.id,
        contentVersion: app.work.contentVersion,
        server,
        access: hostAccess.asks,
        dataFolder: await this.storage.functionsFolder(app.work.id),
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
