import { integrationSlug, solusServerIdOf, type Integration, type IntegrationCreateRequest, type IntegrationProbeResult, type IntegrationProbeUndeterminedReason } from '@solus/contracts/integration-types'
import { organizationForNew, type Principal } from '../admission/principal'
import type { HostEventPublisher } from '../transport/events/host-event-publisher'
import type { IntegrationStore } from './integration-store'
import { probeMcpServer } from './probe'
import { probeSolusServer } from './solus-servers'

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
 * Solus MCP server's code decides its own auth (§13.6).
 */
export function probeAddress(url: string): Promise<IntegrationProbeResult> {
  return solusServerIdOf(url) ? Promise.resolve(probeSolusServer(url)) : probeMcpServer(url)
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
export async function createIntegration(deps: IntegrationCreateDeps, principal: Principal, owner: string, request: IntegrationCreateRequest): Promise<Integration> {
  const probe = await probeForWrite(request.url)
  const integration = deps.store.create(
    { name: request.name, url: request.url, slug: integrationSlug(request.slug ?? request.name), auth: probe.auth },
    organizationForNew(principal),
    owner,
  )
  void deps.events.broadcast('integration.changed', { integrationId: integration.id, change: 'created' })
  void deps.profile?.saved(principal, integration)
  return integration
}
