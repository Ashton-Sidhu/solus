import { agentAuthFlowRequestSchema, agentAuthMcpTargetSchema, agentAuthSubmitRequestSchema, agentAuthTargetSchema } from '@solus/contracts/agent-auth'
import { agentProfileBundleSchema } from '@solus/contracts/agent-profile'
import { seatConnectCodeRequestSchema, seatConnectTokenRequestSchema, seatProviderRequestSchema, seatRemoveRequestSchema } from '@solus/contracts/seats'
import { parseUserKey } from '@solus/contracts/user'
import type { AgentAuthFlows } from '../../execution/seats/agent-auth'
import type { AgentProfileManager, AgentProfileTarget } from '../../execution/seats/agent-profile'
import type { SeatConnector } from '../../execution/seats/seat-connect'
import { isHostOwner, type Principal } from '../../admission/principal'
import type { SeatStore } from '../../execution/seats/seat-manager'
import { seatFor } from '../../admission/actor'
import type { SolusServer } from '../server'

/**
 * The caller's own provider seats on this host (docs/plans/provider-seats.md
 * §3.6). The seat user comes from the principal, never from the request: the host
 * owner's seat is the host login, a member's is their own, and a guest is refused
 * by the access policy. Removal is the administrator's. The workspace service
 * refuses these execution-plane methods.
 */
export function registerSeatHandlers(server: SolusServer, deps: { seats: SeatStore; connector: SeatConnector; profiles: AgentProfileManager; agentAuth: AgentAuthFlows }): void {
  server.register('seatList', (_args, ctx) => deps.seats.list(seatFor(ctx.actor)))

  server.register('seatConnectStart', (args, ctx) => {
    const { provider } = seatProviderRequestSchema.parse(args[0])
    return deps.connector.start(seatFor(ctx.actor), provider)
  })

  server.register('seatConnectSubmitCode', (args, ctx) => {
    const { provider, code } = seatConnectCodeRequestSchema.parse(args[0])
    deps.connector.submitCode(seatFor(ctx.actor), provider, code)
    return { submitted: true as const }
  })

  server.register('seatConnectCancel', async (args, ctx) => {
    const { provider } = seatProviderRequestSchema.parse(args[0])
    return { cancelled: await deps.connector.cancel(seatFor(ctx.actor), provider) }
  })

  server.register('seatConnectToken', async (args, ctx) => {
    const { provider, token } = seatConnectTokenRequestSchema.parse(args[0])
    const seat = seatFor(ctx.actor)
    await deps.connector.cancel(seat, provider)
    return deps.seats.storeToken(seat, provider, token)
  })

  server.register('seatDisconnect', async (args, ctx) => {
    const { provider } = seatProviderRequestSchema.parse(args[0])
    const seat = seatFor(ctx.actor)
    await deps.connector.cancel(seat, provider)
    return deps.seats.disconnect(seat, provider)
  })

  server.register('seatRemove', async (args) => {
    const request = seatRemoveRequestSchema.parse(args[0])
    const userId = parseUserKey(request.userId)
    const provider = request.provider
    for (const each of provider ? [provider] : (['claude-code', 'codex'] as const)) await deps.connector.cancel({ kind: 'user', userId }, each)
    return { removed: await deps.seats.remove(userId, provider) }
  })

  // Claude Design and MCP server sign-ins run in the caller's seat, like the connect above.
  server.register('agentAuthStart', (args, ctx) => deps.agentAuth.start(seatFor(ctx.actor), agentAuthTargetSchema.parse(args[0])))

  server.register('agentAuthSubmit', async (args, ctx) => {
    const { flowId, value } = agentAuthSubmitRequestSchema.parse(args[0])
    await deps.agentAuth.submit(seatFor(ctx.actor), flowId, value)
    return { submitted: true as const }
  })

  server.register('agentAuthCancel', (args, ctx) => {
    const { flowId } = agentAuthFlowRequestSchema.parse(args[0])
    return { cancelled: deps.agentAuth.cancel(seatFor(ctx.actor), flowId) }
  })

  server.register('agentAuthSignOut', (args, ctx) => deps.agentAuth.signOut(seatFor(ctx.actor), agentAuthMcpTargetSchema.parse(args[0])))

  // An agent profile (docs/agent-profile.md) is read on the machine a person
  // works on, which the access policy leaves to its administrator, and written
  // into a member's own seats, or into the owner's own homes on a host they own.
  // A guest has no homes of their own here, so a guest may not write one.
  server.register('agentProfileRead', () => deps.profiles.read())

  server.register('agentProfileApply', (args, ctx) => {
    const bundle = agentProfileBundleSchema.parse(args[0])
    const target = profileTargetOf(ctx.principal)
    // An empty bundle is the client's Remove.
    return bundle.files.length === 0 && bundle.skipped.length === 0 ? deps.profiles.remove(target) : deps.profiles.apply(target, bundle)
  })

  server.register('agentProfileStatus', (_args, ctx) => deps.profiles.status(profileTargetOf(ctx.principal)))
}

function profileTargetOf(principal: Principal): AgentProfileTarget {
  if (principal.kind === 'org-member') return { kind: 'member', userId: principal.userId, name: principal.displayName }
  if (isHostOwner(principal)) return { kind: 'owner' }
  throw new Error('Only the owner or an organization member has an agent profile on this host.')
}
