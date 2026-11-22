import { integrationSlug, solusServerIdOf, type Integration, type IntegrationAuth, type IntegrationAuthChoice, type IntegrationCommandCreateRequest, type IntegrationOAuthClientInput, type IntegrationLaunch, type IntegrationProbeResult, type IntegrationProbeUndeterminedReason, type IntegrationUpdateRequest, type IntegrationUrlCreateRequest } from '@solus/contracts/integration-types'
import { basename } from 'node:path'
import { splitCommandLine } from '@solus/contracts/integrations/command-line'
import { OAuthSignInError } from '@solus/contracts/integrations/oauth-protocol'
import { organizationForNew, recordScopeOf, type Principal } from '../admission/principal'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import { resolveProjectKey, resolveProjectRoot } from '../project-config/project-config'
import type { HostEventPublisher } from '../transport/events/host-event-publisher'
import { cliSkipLog } from './cli-skips'
import { COMMAND_CHANGE_REFUSAL, mayRunCommands } from './command-admission'
import type { IntegrationConnections } from './connections'
import type { IntegrationGateway } from './gateway'
import type { IntegrationCreateInput, IntegrationPatch, IntegrationStore } from './integration-store'
import type { IntegrationOAuth } from './oauth'
import { probeMcpServer } from './probe'
import { probeSolusServer } from './solus-servers'
import { stdioServerAddress } from './stdio-process'

const log = createLogger('integrations', 'integration-create.ts')

/** Why a probe decided nothing, as the person reads it. */
const UNDETERMINED_MESSAGES = {
  unavailable: 'The server is unavailable right now. Try again later.',
  unreachable: 'Solus could not reach the server.',
  timeout: 'The server did not answer in time.',
  redirected: 'The server redirected the request. Use the address it redirects to.',
  refused: 'The server refused the request, or the address is not public.',
  not_mcp: 'The address did not answer as an MCP server.',
  initialize_error: 'The server refused to start an MCP session.',
  tools_error: 'The server did not list its tools.',
  oauth_unusable: 'The server advertises a sign-in that Solus cannot use.',
} satisfies Record<IntegrationProbeUndeterminedReason, string>

/** The probe decided nothing, so no integration is written. */
export class IntegrationProbeRefusedError extends Error {
  constructor(readonly reason: IntegrationProbeUndeterminedReason) {
    super(UNDETERMINED_MESSAGES[reason])
    this.name = 'IntegrationProbeRefusedError'
  }
}

/**
 * How an address connects: a remote server is probed over the network; a
 * Solus MCP server's code decides its own auth (§13.6). A server on the host's
 * own loopback is allowed; other private addresses stay refused.
 */
export function probeAddress(url: string): Promise<IntegrationProbeResult> {
  return solusServerIdOf(url) ? Promise.resolve(probeSolusServer(url)) : probeMcpServer(url, { allowLoopback: true })
}

/** Probe an address before it is stored; an undetermined answer refuses the write. */
export async function probeForWrite(url: string) {
  const probe = await probeAddress(url)
  if (probe.outcome === 'undetermined') throw new IntegrationProbeRefusedError(probe.reason)
  return probe
}

/** The undetermined answers that say the server was not reached: they refuse an add even when the person chose the authentication. */
const NOT_REACHED = new Set<IntegrationProbeUndeterminedReason>(['unreachable', 'timeout', 'redirected', 'unavailable'])

const NO_OAUTH_MESSAGE = 'The server does not offer an OAuth sign-in. Choose another authentication.'

/**
 * Probe an address, then give its auth from the person's choice and the probe
 * (docs/plans/mcp-add-server.md): for a new server, or a new address of a
 * server whose headers the person chose. `automatic` keeps what the probe found.
 * `oauth` needs OAuth the probe found, on a refusal or offered by a server
 * that also works without it. `bearer`, `none`, and `headers` need only a
 * server the probe reached.
 */
export async function chosenAuth(url: string, choice: IntegrationAuthChoice, oauth: IntegrationWritesDeps['oauth']): Promise<IntegrationAuth> {
  // A Solus MCP server's code decides its sign-in (§13.6): no choice replaces it.
  if (solusServerIdOf(url) && choice.kind !== 'automatic' && choice.kind !== 'oauth') throw new Error('A Solus MCP server signs in as Solus sets it up. Choose Automatic.')
  const found = foundAuth(choice, await probeAddress(url))
  switch (choice.kind) {
    case 'automatic':
      return found ?? { kind: 'none' }
    case 'oauth':
      return oauthOf(url, found, oauth)
    case 'bearer':
      return { kind: 'bearer', scheme: found?.kind === 'bearer' && found.scheme !== 'unspecified' ? found.scheme : 'bearer' }
    case 'none':
      return { kind: 'none' }
    case 'headers':
      return { kind: 'headers', names: choice.names }
  }
}

/**
 * The auth the probe found, or null when it decided nothing but reached the
 * server and the person chose an authentication that does not need its answer.
 * An address that is not public sends no request, so it stays refused.
 */
function foundAuth(choice: IntegrationAuthChoice, probe: IntegrationProbeResult): IntegrationAuth | null {
  if (probe.outcome !== 'undetermined') return probe.auth
  const reached = !NOT_REACHED.has(probe.reason) && probe.signals.some((signal) => signal.kind === 'request')
  if (choice.kind === 'automatic' || choice.kind === 'oauth' || !reached) throw new IntegrationProbeRefusedError(probe.reason)
  return null
}

/** The OAuth the probe found: on a refusal, or offered by a server that also works without it, read from the address it names. */
async function oauthOf(url: string, found: IntegrationAuth | null, oauth: IntegrationWritesDeps['oauth']): Promise<IntegrationAuth> {
  if (found?.kind === 'oauth') return found
  if (found?.kind !== 'none' || !found.oauth) throw new Error(NO_OAUTH_MESSAGE)
  try {
    return await oauth.oauthAuthAt(url, found.oauth.discover)
  } catch (error) {
    throw new Error(error instanceof OAuthSignInError ? error.message : NO_OAUTH_MESSAGE, { cause: error })
  }
}

export interface IntegrationWritesDeps {
  store: IntegrationStore
  events: HostEventPublisher
  /** The person's agent profile (plans/020-agent-profile.md); absent where no profile applies. */
  profile?: { saved(principal: Principal, integration: Integration): Promise<void> }
  gateway: Pick<IntegrationGateway, 'forget' | 'invalidate'>
  connections: Pick<IntegrationConnections, 'removeAllFor'>
  /** The OAuth of a server the person chose OAuth for, and the owner's client they gave with it. */
  oauth: Pick<IntegrationOAuth, 'oauthAuthAt' | 'withOwnerClient'>
}

/**
 * The one writer of integration records (docs/plans/mcp-integrations.md §12):
 * Settings (`integrationCreate`, `integrationUpdate`), the agent
 * (`connect_integration`, §13.2), and Found (mcp-first-class.md §8.3) add and
 * change a record here, so each write tells the gateway, the CLI skip log, the
 * clients, and the profile the same way. A new record starts in the
 * principal's organization for new records.
 */
export class IntegrationWrites {
  constructor(private readonly deps: IntegrationWritesDeps) {}

  /**
   * Probe, then write a new server at a URL owned by `owner`, with the
   * authentication the person chose (`automatic` when left out). With OAuth,
   * the chosen scopes go on the record and the owner's client is saved. With
   * `projectRoot` it joins only that project's runs (§8.4).
   */
  async addServer(principal: Principal, owner: string, request: IntegrationUrlCreateRequest, projectRoot?: string): Promise<Integration> {
    const choice = request.auth ?? { kind: 'automatic' }
    const auth = await chosenAuth(request.url, choice, this.deps.oauth)
    const oauthChoice = choice.kind === 'automatic' || choice.kind === 'oauth' ? choice : null
    if (auth.kind === 'oauth' && oauthChoice?.scopes) auth.scopes = oauthChoice.scopes
    const input: IntegrationCreateInput = { name: request.name, url: request.url, slug: integrationSlug(request.slug ?? request.name), auth }
    if (projectRoot) Object.assign(input, projectOf(projectRoot))
    let integration = this.deps.store.create(input, organizationForNew(principal), owner)
    const client = auth.kind === 'oauth' ? oauthChoice?.client : undefined
    if (client) integration = await this.withClient(integration, client)
    // The kind only: a header name or a scope is the person's setup, not a fact to log.
    log.info('integration_server_added', { integrationId: integration.id, choice: choice.kind, auth: auth.kind, client: client !== undefined })
    void this.deps.events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
    this.toProfile(principal, integration)
    return integration
  }

  /**
   * The owner's client given with the add. A client the host cannot save (the
   * issuer did not answer, or no safe store) takes the new record back, so the
   * person adds the server again rather than find a record without their client.
   */
  private async withClient(integration: Integration, client: IntegrationOAuthClientInput): Promise<Integration> {
    try {
      const auth = await this.deps.oauth.withOwnerClient(integration, client)
      return this.deps.store.update(integration.id, { auth }, integration.organizationId) ?? integration
    } catch (error) {
      this.deps.store.remove(integration.id, integration.organizationId)
      throw error
    }
  }

  /**
   * Write a new `stdio` integration (mcp-first-class.md §7). It starts
   * nothing: the person starts it from Settings, after they saw the command.
   * The caller checks `host.admin` (§7.2). A command is not an agent profile
   * entry, so the profile does not hear of it (§7.8). With `projectPath` it
   * joins only that project's runs, and runs in the project's root when it
   * names no folder (§8.4).
   */
  addCommand(principal: Principal, owner: string, request: IntegrationCommandCreateRequest): Integration {
    const launch: IntegrationLaunch = { ...launchOfRequest(request) }
    const projectRoot = request.projectPath ? resolveProjectRoot(resolveHomePath(request.projectPath)) : null
    launch.cwd ??= projectRoot ?? undefined
    if (launch.cwd === undefined) delete launch.cwd
    const input: IntegrationCreateInput = { name: request.name, url: stdioServerAddress(launch), slug: integrationSlug(request.slug ?? request.name), auth: commandAuth(request.envNames), launch }
    if (projectRoot) Object.assign(input, projectOf(projectRoot))
    const integration = this.deps.store.create(input, organizationForNew(principal), owner)
    // Neither the command nor its arguments are logged: an argument can hold a secret.
    log.info('integration_command_added', { integrationId: integration.id, envNames: request.envNames.length, project: projectRoot !== null })
    void this.deps.events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
    return integration
  }

  /**
   * A new command or new names for a `stdio` integration (§7.6): `host.admin`
   * only. The verdict and the facts belonged to the old command (§7.5), so they
   * go and the process stops; every person gives values for new names again.
   */
  changeCommand(existing: Integration, request: Pick<IntegrationUpdateRequest, 'name' | 'disabledTools' | 'launch' | 'envNames'>, principal: Principal): Integration {
    if (!mayRunCommands(principal)) throw new Error(COMMAND_CHANGE_REFUSAL)
    const patch: IntegrationPatch = { name: request.name, disabledTools: request.disabledTools }
    if (request.launch) {
      patch.launch = request.launch
      patch.url = stdioServerAddress(request.launch)
    }
    if (request.envNames) patch.auth = commandAuth(request.envNames)
    const integration = this.updated(existing, patch, principal)
    this.deps.gateway.forget(existing.id)
    if (request.envNames) this.deps.connections.removeAllFor(existing)
    this.changed(existing)
    return integration
  }

  /**
   * A server's new name, address, auth, or tool filter. The caller probed a new
   * address. New header names drop every person's values, as new names of a
   * command do: each person gives values for the new names again.
   */
  changeServer(existing: Integration, patch: Pick<IntegrationPatch, 'name' | 'url' | 'auth' | 'disabledTools'>, principal: Principal): Integration {
    const integration = this.updated(existing, patch, principal)
    // Turning tools on or off keeps the upstream session: the filter is on the record.
    if (patch.name !== undefined || patch.url !== undefined || patch.auth !== undefined) this.deps.gateway.invalidate(existing.id)
    if (headerNamesOf(existing) !== headerNamesOf(integration)) this.deps.connections.removeAllFor(existing)
    this.changed(existing)
    this.toProfile(principal, integration)
    return integration
  }

  private updated(existing: Integration, patch: IntegrationPatch, principal: Principal): Integration {
    const integration = this.deps.store.update(existing.id, patch, recordScopeOf(principal))
    if (!integration) throw new Error('That integration is no longer on this host.')
    return integration
  }

  /** Every tool off, a new address, or a new command can give the CLI its copy back at the next run (§8.5). */
  private changed(existing: Integration): void {
    cliSkipLog.forget(existing.id)
    void this.deps.events.broadcast('integration.changed', { integrationId: existing.id, change: 'updated' })
  }

  /** A project's file is in the repository, so each host finds it again: a project record is no profile entry (§8.4). */
  private toProfile(principal: Principal, integration: Integration): void {
    if (integration.projectKey === undefined) void this.deps.profile?.saved(principal, integration)
  }
}

/** A `headers` server's header names as one comparable value; null for any other auth. */
function headerNamesOf(integration: Integration): string | null {
  return integration.auth.kind === 'headers' ? integration.auth.names.join('\u0000') : null
}

/** The project an integration from a project's file joins (§8.4): its key, and its folder name for the row. */
function projectOf(projectRoot: string): Pick<IntegrationCreateInput, 'projectKey' | 'projectName'> {
  return { projectKey: resolveProjectKey(projectRoot), projectName: basename(projectRoot) || projectRoot }
}

/** The program and arguments of a command request: the host splits a typed line by the one rule (§7.4). Throws the reason. */
function launchOfRequest(request: Pick<IntegrationCommandCreateRequest, 'commandLine' | 'launch'>): IntegrationLaunch {
  if (request.launch) return request.launch
  const split = splitCommandLine(request.commandLine ?? '')
  if (!split.ok) throw new Error(split.reason)
  return split.launch
}

/** `env` with the names, or `none` for a command that needs no variable (§7.1). */
function commandAuth(envNames: string[]): IntegrationAuth {
  return envNames.length ? { kind: 'env', names: envNames } : { kind: 'none' }
}
