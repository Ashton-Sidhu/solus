import { consumeWsTicket, getInstallationId, isDeviceRevoked, SESSION_TOKEN_TTL_MS, verifySessionToken } from '../../admission/auth'
import { principalFor, type Principal } from '../../admission/principal'
import type { WorkspaceAuthSessionRequest } from '@solus/contracts/solus-api'
import { WorkspaceCredentials } from '../../admission/workspace-credentials'
import { delegationScopesFor } from '../../sync/delegations'
import { ticketForDelegatedMember, ticketForGrant, ticketForShareSecret, type HttpServerOptions } from '../http'

/** Shares token admission with socket connections. The ticket is consumed in-process; no socket is opened. */
export function workspaceCredentialsForHttp(options: HttpServerOptions): WorkspaceCredentials {
  const serviceId = options.solusApi?.serviceId ?? getInstallationId()
  return new WorkspaceCredentials({
    audience: serviceId, secret: options.solusApi?.signingKey,
    authenticateSource: async (bearer, request) => {
      if (!bearer) return options.resolveShareSecret ? linkGuest(request, options.resolveShareSecret) : null
      const organizationId = request.organizationId
      if (!options.pairingDisabled && !options.isApiMode) {
        const paired = verifySessionToken(bearer)
        if (paired) return { principal: { kind: 'local-owner', deviceId: paired.deviceId, deviceLabel: paired.deviceLabel }, expiresAt: paired.issuedAt + SESSION_TOKEN_TTL_MS }
      }
      const verdict = await options.verifyAccessToken?.(bearer)
      if (!verdict?.ok) return null
      // A host's delegated token (plans/010-standard-oauth.md) stands for its person, in
      // the organization it names; the credential records which host acts for them.
      const claims = verdict.claims
      const act = claims.act
      if (act && !options.isApiMode) return null
      const admitted = claims.act ? ticketForDelegatedMember(claims) : await ticketForGrant(claims, { workspace: options.isApiMode, organizationId })
      if (!admitted.ok) return null
      // A person's token makes this server's delegations for them: how it reads their account (ADR 0001 §3.4, §6.2).
      if (!claims.act && options.establishDelegation) {
        for (const scope of delegationScopesFor(claims, organizationId)) options.establishDelegation(bearer, scope).catch(() => undefined)
      }
      const ticket = consumeWsTicket(admitted.ticket)
      if (!ticket) return null
      const principal = principalFor({ kind: 'ticket', ticket })
      if (!act) return { principal, expiresAt: verdict.claims.exp * 1000 }
      return principal.kind === 'org-member' && act.host_id ? { principal, expiresAt: verdict.claims.exp * 1000, delegation: { hostId: act.host_id } } : null
    },
    isRevoked: async principal => principal.kind !== 'system' && !!principal.deviceId && isDeviceRevoked(principal.deviceId),
    homeFor: principal => {
      if (options.isApiMode) {
        return (principal.kind === 'org-member' || principal.kind === 'guest') && principal.organizationId
          ? { kind: 'organization', serviceId, organizationId: principal.organizationId } : null
      }
      return principal.kind === 'local-owner' || principal.kind === 'remote-owner' || principal.kind === 'org-member' || principal.kind === 'guest'
        ? { kind: 'local', hostId: serviceId } : null
    },
  })
}

/**
 * A person's own access token, as a member of one organization: how a share link's
 * resolve learns whether the visitor opens it as themselves
 * (docs/plans/instant-share-open.md). Null for no token, a host's delegated token, or a
 * person the token does not list in that organization.
 */
export async function organizationMemberFor(options: HttpServerOptions, bearer: string, organizationId: string): Promise<Principal | null> {
  if (!bearer || bearer.length > 16_384) return null
  const verdict = await options.verifyAccessToken?.(bearer)
  if (!verdict?.ok || verdict.claims.act) return null
  const admitted = await ticketForGrant(verdict.claims, { workspace: true, organizationId })
  const ticket = admitted.ok ? consumeWsTicket(admitted.ticket) : null
  const principal = ticket ? principalFor({ kind: 'ticket', ticket }) : null
  return principal?.kind === 'org-member' ? principal : null
}

/**
 * A link guest: the same guest, bound to the same one resource, as the ticket door
 * admits (host-sharing.md §4.1 step 4). Its role is the link's as it stands at each
 * request, and it ends when the link is removed or regenerated (`ShareManager.roleFor`).
 */
async function linkGuest(request: WorkspaceAuthSessionRequest, resolveShareSecret: NonNullable<HttpServerOptions['resolveShareSecret']>): Promise<{ principal: Principal; expiresAt: number } | null> {
  const outcome = await ticketForShareSecret(request, resolveShareSecret)
  const ticket = outcome.ok ? consumeWsTicket(outcome.ticket) : null
  if (!ticket) return null
  const principal = principalFor({ kind: 'ticket', ticket })
  return principal.kind === 'guest' ? { principal, expiresAt: principal.expiresAt } : null
}
