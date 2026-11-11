import { z } from 'zod'
import {
  DEFAULT_APP_PERMISSIONS,
  parseAppToolName,
  type AppCallRequest,
  type AppPermissionsUpdate,
  type AppRequest,
  type AppRoleState,
  type AppSnapshot,
  type AppToolRequest,
} from '@solus/contracts/apps'
import { MCP_APP_MAX_DATA_BYTES, type McpAppToolInfo } from '@solus/contracts/mcp-apps'
import type { Integration } from '@solus/contracts/integration-types'
import type { HandlerCtx } from '../transport/server'
import { recordScopeOf } from '../admission/principal'
import { ownerKeyOf } from '../admission/actor'
import { Work } from '../data/works/work'
import type { IntegrationGateway } from '../integrations/gateway'
import type { IntegrationStore } from '../integrations/integration-store'
import { admits } from './app-permissions'
import { compileAppComponent, extractAppRoles } from './app-source'
import { composeAppDocument, loadAppShell } from './app-shell'

const APP_UNAVAILABLE = 'This app is not available.'

const argumentsSchema = z.record(z.string(), z.json())

/**
 * Apps (docs/plans/apps.md §6): an `app` work's document, and the calls its
 * frame makes. Every call loads the work in the caller's scope, resolves the
 * role to the caller's own integration, and checks the app's permissions
 * under the gateway's own rules, on every call.
 */
export class Apps {
  constructor(
    private readonly gateway: Pick<IntegrationGateway, 'callAppTool' | 'toolsFor' | 'connectionStatus'>,
    private readonly store: Pick<IntegrationStore, 'getBySlug'>,
  ) {}

  async read(request: AppRequest, ctx: HandlerCtx): Promise<AppSnapshot> {
    return this.snapshot(await this.app(request, ctx), ctx)
  }

  async permissionsUpdate(request: AppPermissionsUpdate, ctx: HandlerCtx): Promise<AppSnapshot> {
    const work = await this.app(request, ctx)
    await work.setAppPermissions(request.permissions)
    return this.snapshot(work, ctx)
  }

  async toolInfo(request: AppToolRequest, ctx: HandlerCtx): Promise<McpAppToolInfo> {
    return (await this.describeTool(await this.app(request, ctx), request.name, ctx)).info
  }

  async callTool(request: AppCallRequest, ctx: HandlerCtx): Promise<string> {
    const { info, target } = await this.describeTool(await this.app(request, ctx), request.name, ctx)
    if (!info.callable || !target) throw new Error(info.refusal ?? `This app cannot call ${request.name}.`)
    if (!info.readOnly && !request.approved) throw new Error('This tool needs your approval.')
    const input = argumentsSchema.parse(JSON.parse(request.argumentsJson))
    const json = JSON.stringify(await this.gateway.callAppTool(target.integration.id, target.tool, input))
    if (Buffer.byteLength(json) > MCP_APP_MAX_DATA_BYTES) throw new Error('This result is too large to display.')
    return json
  }

  /** The work, in the caller's scope: another person's id does not resolve. */
  private async app(request: AppRequest, ctx: HandlerCtx): Promise<Work> {
    const work = await Work.find(recordScopeOf(ctx.principal), request.workId)
    if (!work || work.type !== 'app') throw new Error(APP_UNAVAILABLE)
    return work
  }

  private async snapshot(work: Work, ctx: HandlerCtx): Promise<AppSnapshot> {
    const permissions = work.app?.permissions ?? DEFAULT_APP_PERMISSIONS
    const roles = await this.roles(work, ctx)
    const html = composeAppDocument({ shell: await loadAppShell(), compiledComponent: compileAppComponent(work.content), roles, permissions })
    return { html, csp: {}, title: work.title, roles, permissions, contentVersion: work.contentVersion }
  }

  /** Each role as the caller sees it: whether they own an integration with that slug, and whether it is connected. */
  private async roles(work: Work, ctx: HandlerCtx): Promise<AppRoleState[]> {
    return Promise.all(extractAppRoles(work.content).map(async (slug) => {
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

  /**
   * The tool as things stand now: the role in the source, the caller's own
   * integration, its hints, the owner's disabled list, and the app's
   * permissions. `target` is set only when the tool is callable.
   */
  private async describeTool(work: Work, name: string, ctx: HandlerCtx): Promise<{ info: McpAppToolInfo; target: { integration: Integration; tool: string } | null }> {
    const named = parseAppToolName(name)
    const refuse = (refusal?: string) => {
      const info: McpAppToolInfo = { callable: false, readOnly: false, title: named?.tool ?? name }
      if (refusal) info.refusal = refusal
      return { info, target: null }
    }
    if (!named || !extractAppRoles(work.content).includes(named.slug)) return refuse()
    const integration = this.integrationFor(named.slug, ctx)
    if (!integration) return refuse(`Connect ${named.slug} in Settings → MCP to use this app.`)
    const tool = (await this.gateway.toolsFor(integration.id, ownerKeyOf(ctx.actor))).find((entry) => entry.name === named.tool)
    if (!tool) return refuse()
    if (integration.disabledTools.includes(named.tool)) return refuse(`The ${named.tool} tool of ${integration.name} is turned off in Settings → MCP.`)
    const permissions = work.app?.permissions ?? DEFAULT_APP_PERMISSIONS
    if (!admits(permissions, name, tool)) return refuse(`This app's permissions do not allow ${tool.title ?? named.tool}.`)
    return {
      info: { callable: true, readOnly: tool.annotations?.readOnlyHint === true || permissions.writes === 'allow', title: tool.title ?? named.tool },
      target: { integration, tool: named.tool },
    }
  }
}
