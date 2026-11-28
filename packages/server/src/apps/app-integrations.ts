import { z } from 'zod'
import type { AppDescriptor, AppRoleState } from '@solus/contracts/apps'
import { CONNECTION_LABELS, isConnectionProvider, type ConnectionProvider } from '@solus/contracts/connections'
import type { Integration } from '@solus/contracts/integration-types'
import { ownerKeyOf } from '../admission/actor'
import { recordScopeOf } from '../admission/principal'
import type { AppRecord, AppVersionRecord } from '../data/apps/app-store'
import { hostUserKey } from '../host/host-user'
import type { IntegrationGateway } from '../integrations/gateway'
import type { IntegrationStore } from '../integrations/integration-store'
import { toolSummary } from '../integrations/integration-tools'
import { withUserScope } from '../vault/acting-scope'
import { CONNECTION_TOOL, type AppConnections } from './app-connections'
import type { StoredValue } from './app-storage'
import type { AppAuthority } from './apps'

/**
 * An app's calls to integrations (docs/plans/apps.md §5): a role the
 * descriptor names, resolved on every call. A role has one of two scopes
 * (docs/plans/app-deploy.md §6). A user connection is the caller's own
 * integration. An app connection is the owner's, for each caller and for the
 * app's background work. A build of protocol 3 has user connections only,
 * and there the host's own work (a schedule, a webhook, a workflow) has no
 * person in its call, so the app's owner is the person. A role named `github`,
 * `atlassian`, or `google` that the person has no MCP integration for is the
 * built-in connection of that name.
 */

type CallInput = { [key: string]: StoredValue }

/** A tool result as an integration answers it. */
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.json().optional(),
  isError: z.boolean().optional(),
})

const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD'])
const previewConnectionMethodSchema = z.object({ method: z.string().optional() })

function assertReadOnlyConnectionRequest(provider: ConnectionProvider, input: CallInput): void {
  const parsed = previewConnectionMethodSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`A preview only allows read-only integration calls: ${CONNECTION_LABELS[provider]} requires a GET or HEAD method in preview.`)
  }
  const rawMethod = parsed.data.method
  if (rawMethod === undefined) return
  const method = rawMethod.trim().toUpperCase()
  if (!READ_ONLY_HTTP_METHODS.has(method)) {
    throw new Error(`A preview only allows read-only integration calls: ${CONNECTION_LABELS[provider]} ${method || 'non-GET'} requests are not allowed in preview.`)
  }
}

function parseToolResult(integrationName: string, result: z.output<typeof toolResultSchema>): StoredValue {
  const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
  if (result.isError) throw new Error(text || `${integrationName} refused the call.`)
  if (result.structuredContent !== undefined) return result.structuredContent
  if (!text) return null
  try {
    return z.json().parse(JSON.parse(text))
  } catch {
    return text
  }
}

export interface AppIntegrationDeps {
  gateway: Pick<IntegrationGateway, 'callAppTool' | 'toolsFor' | 'connectionStatus'>
  integrations: Pick<IntegrationStore, 'getBySlug'>
  connections: AppConnections
  /** Runs an integration call as a person, for a caller with no person of its own. `withUserScope` on a host. */
  runAs?: <T>(personKey: string | null, run: () => T) => T
}

export class AppIntegrationCalls {
  constructor(private readonly deps: AppIntegrationDeps) {}

  /** The caller's own integration with a slug; for the host's own work, the app owner's. */
  private integrationFor(app: AppRecord, slug: string, authority: AppAuthority | null): Integration | null {
    const personKey = authority ? ownerKeyOf(authority.actor) ?? app.ownerKey : app.ownerKey
    return this.deps.integrations.getBySlug(slug, authority ? recordScopeOf(authority.principal) : app.organizationId, personKey)
  }

  /** One integration tool for the app (§5): a role the descriptor names, a connection of the role's scope, and a tool that is on. */
  async call(app: AppRecord, version: AppVersionRecord, slug: string, toolName: string, input: CallInput, caller: AppAuthority | null): Promise<StoredValue> {
    if (!version.descriptor.integrations.includes(slug)) throw new Error(`This app does not name the integration ${slug}. Add it to \`integrations\` in app.ts.`)
    const isAppConnection = version.descriptor.appIntegrations.includes(slug)
    if (!isAppConnection && !caller && version.descriptor.solusApp >= 4) {
      throw new Error(`The integration ${slug} is a user connection, and this call has no person. Name it in \`appIntegrations\` in app.ts to use the owner's connection.`)
    }
    // An app connection is the owner's, whoever calls.
    const authority = isAppConnection ? null : caller
    const integration = this.integrationFor(app, slug, authority)
    if (!integration && isConnectionProvider(slug)) return this.callConnection(app, slug, toolName, input, authority)
    if (!integration) throw new Error(`Connect ${slug} in Settings → MCP to use this app.`)
    if (integration.disabledTools.includes(toolName)) throw new Error(`The ${toolName} tool of ${integration.name} is turned off in Settings → MCP.`)
    // The host's own work has no principal, so it starts no command (`commandStartRefusal`).
    const result = toolResultSchema.parse(await this.asPerson(app, authority, () => this.deps.gateway.callAppTool(integration.id, toolName, input, authority?.principal ?? null)))
    return parseToolResult(integration.name, result)
  }

  /** One read-only integration tool for a preview: a role the descriptor names, the caller's own connection, and a tool or request that only reads. */
  async callReadOnly(descriptor: AppDescriptor, slug: string, toolName: string, input: CallInput, authority: AppAuthority): Promise<StoredValue> {
    if (!descriptor.integrations.includes(slug) && !descriptor.appIntegrations.includes(slug)) {
      throw new Error(`This app does not name the integration ${slug}. Add it to \`integrations\` in app.ts.`)
    }
    const personKey = ownerKeyOf(authority.actor) ?? hostUserKey()
    const integration = this.deps.integrations.getBySlug(slug, recordScopeOf(authority.principal), personKey)
    if (!integration && isConnectionProvider(slug)) {
      if (toolName !== CONNECTION_TOOL) throw new Error(`${CONNECTION_LABELS[slug]} has one tool for an app: ${CONNECTION_TOOL}.`)
      assertReadOnlyConnectionRequest(slug, input)
      return this.deps.connections.request(slug, input)
    }
    if (!integration) throw new Error(`Connect ${slug} in Settings → MCP to use this app.`)
    if (integration.disabledTools.includes(toolName)) throw new Error(`The ${toolName} tool of ${integration.name} is turned off in Settings → MCP.`)
    const tools = await this.deps.gateway.toolsFor(integration.id, personKey)
    const tool = tools.find((candidate) => candidate.name === toolName)
    const summary = tool ? toolSummary(tool) : null
    if (!summary || !summary.readOnly || summary.destructive) {
      throw new Error(`A preview only allows read-only integration calls: ${integration.name}'s ${toolName} tool is not marked read-only.`)
    }
    const result = toolResultSchema.parse(await this.deps.gateway.callAppTool(integration.id, toolName, input, authority.principal))
    return parseToolResult(integration.name, result)
  }

  /** A built-in connection's one tool, as the caller's or, for the host's own work, the owner's credential. */
  private callConnection(app: AppRecord, provider: ConnectionProvider, toolName: string, input: CallInput, authority: AppAuthority | null): Promise<StoredValue> {
    if (toolName !== CONNECTION_TOOL) throw new Error(`${CONNECTION_LABELS[provider]} has one tool for an app: ${CONNECTION_TOOL}.`)
    return this.asPerson(app, authority, () => this.deps.connections.request(provider, input))
  }

  /** A schedule, a webhook, or a workflow has no person in its call: the app's owner is the person. */
  private asPerson<T>(app: AppRecord, authority: AppAuthority | null, run: () => T): T {
    return authority ? run() : (this.deps.runAs ?? withUserScope)(app.ownerKey, run)
  }

  /** Each role as the reader has it: whether they own an integration with that slug, and whether it is connected. */
  async roles(app: AppRecord, descriptor: AppDescriptor, authority: AppAuthority): Promise<AppRoleState[]> {
    return Promise.all(descriptor.integrations.map(async (slug): Promise<AppRoleState> => {
      const scope = descriptor.appIntegrations.includes(slug) ? 'app' : 'user'
      const integration = this.integrationFor(app, slug, authority)
      if (!integration && isConnectionProvider(slug)) return { slug, scope, name: CONNECTION_LABELS[slug], connected: await this.deps.connections.connected(slug) }
      if (!integration) return { slug, scope, name: null, connected: false }
      const status = await this.deps.gateway.connectionStatus(integration.id)
      return { slug, scope, name: integration.name, connected: status.status === 'connected' }
    }))
  }
}
