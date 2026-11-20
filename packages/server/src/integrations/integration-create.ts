import { integrationSlug, solusServerIdOf, type Integration, type IntegrationAuth, type IntegrationCommandCreateRequest, type IntegrationLaunch, type IntegrationProbeResult, type IntegrationProbeUndeterminedReason, type IntegrationUpdateRequest, type IntegrationUrlCreateRequest } from '@solus/contracts/integration-types'
import { basename } from 'node:path'
import { splitCommandLine } from '@solus/contracts/integrations/command-line'
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

export interface IntegrationCreateDeps {
  store: IntegrationStore
  events: HostEventPublisher
  /** The person's agent profile (plans/020-agent-profile.md); absent where no profile applies. */
  profile?: { saved(principal: Principal, integration: Integration): Promise<void> }
}

/**
 * Probe, then write a new integration owned by `owner` in the principal's
 * organization for new records (docs/plans/mcp-integrations.md §12). The one
 * path for Settings (`integrationCreate`) and the agent (`connect_integration`,
 * §13.2), so the two cannot create different records.
 */
export async function createIntegration(deps: IntegrationCreateDeps, principal: Principal, owner: string, request: IntegrationUrlCreateRequest, projectRoot?: string): Promise<Integration> {
  const probe = await probeForWrite(request.url)
  const input: IntegrationCreateInput = { name: request.name, url: request.url, slug: integrationSlug(request.slug ?? request.name), auth: probe.auth }
  // A server from a project file joins only that project's runs (mcp-first-class.md §8.4).
  if (projectRoot) Object.assign(input, projectOf(projectRoot))
  const integration = deps.store.create(input, organizationForNew(principal), owner)
  void deps.events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
  // The project's file is in the repository, so each host finds it again: it is no profile entry.
  if (!projectRoot) void deps.profile?.saved(principal, integration)
  return integration
}

/** The project an integration from a project's file joins (§8.4): its key, and its folder name for the row. */
function projectOf(projectRoot: string): Pick<IntegrationCreateInput, 'projectKey' | 'projectName'> {
  return { projectKey: resolveProjectKey(projectRoot), projectName: basename(projectRoot) || projectRoot }
}

/** The program and arguments of a command request: the host splits a typed line by the one rule (§7.4). Throws the reason. */
export function launchOfRequest(request: Pick<IntegrationCommandCreateRequest, 'commandLine' | 'launch'>): IntegrationLaunch {
  if (request.launch) return request.launch
  const split = splitCommandLine(request.commandLine ?? '')
  if (!split.ok) throw new Error(split.reason)
  return split.launch
}

/** `env` with the names, or `none` for a command that needs no variable (§7.1). */
export function commandAuth(envNames: string[]): IntegrationAuth {
  return envNames.length ? { kind: 'env', names: envNames } : { kind: 'none' }
}

/**
 * Write a new `stdio` integration (docs/plans/mcp-first-class.md §7). It
 * starts nothing: the person starts it from Settings, after they saw the
 * command. The caller checks `host.admin` (§7.2). A command is not an agent
 * profile entry, so the profile does not hear of it (§7.8). With
 * `projectPath` it joins only that project's runs, and runs in the project's
 * root when it names no folder (§8.4).
 */
export function createStdioIntegration(deps: Pick<IntegrationCreateDeps, 'store' | 'events'>, principal: Principal, owner: string, request: IntegrationCommandCreateRequest): Integration {
  const launch: IntegrationLaunch = { ...launchOfRequest(request) }
  const projectRoot = request.projectPath ? resolveProjectRoot(resolveHomePath(request.projectPath)) : null
  launch.cwd ??= projectRoot ?? undefined
  if (launch.cwd === undefined) delete launch.cwd
  const input: IntegrationCreateInput = { name: request.name, url: stdioServerAddress(launch), slug: integrationSlug(request.slug ?? request.name), auth: commandAuth(request.envNames), launch }
  if (projectRoot) Object.assign(input, projectOf(projectRoot))
  const integration = deps.store.create(input, organizationForNew(principal), owner)
  // Neither the command nor its arguments are logged: an argument can hold a secret.
  log.info('integration_command_added', { integrationId: integration.id, envNames: request.envNames.length, project: projectRoot !== null })
  void deps.events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
  return integration
}

export interface CommandChangeDeps extends Pick<IntegrationCreateDeps, 'store' | 'events'> {
  gateway: Pick<IntegrationGateway, 'forget'>
  connections: Pick<IntegrationConnections, 'removeAllFor'>
}

/**
 * A new command or new names for a `stdio` integration (§7.6): `host.admin`
 * only. The verdict and the facts belonged to the old command (§7.5), so they
 * go and the process stops; every person gives values for new names again.
 */
export function updateCommand(deps: CommandChangeDeps, existing: Integration, request: Pick<IntegrationUpdateRequest, 'name' | 'disabledTools' | 'launch' | 'envNames'>, principal: Principal): Integration {
  if (!mayRunCommands(principal)) throw new Error(COMMAND_CHANGE_REFUSAL)
  const patch: IntegrationPatch = { name: request.name, disabledTools: request.disabledTools }
  if (request.launch) {
    patch.launch = request.launch
    patch.url = stdioServerAddress(request.launch)
  }
  if (request.envNames) patch.auth = commandAuth(request.envNames)
  const integration = deps.store.update(existing.id, patch, recordScopeOf(principal))
  if (!integration) throw new Error('That integration is no longer on this host.')
  deps.gateway.forget(existing.id)
  cliSkipLog.forget(existing.id)
  if (request.envNames) deps.connections.removeAllFor(existing)
  void deps.events.broadcast('integration.changed', { integrationId: existing.id, change: 'updated' })
  return integration
}
