import { rememberPersonToken } from '../../vault/account-integrations'
import { consumeWsTicket, getInstallationId, isDeviceRevoked, SESSION_TOKEN_TTL_MS, verifySessionToken } from '../../admission/auth'
import { principalFor } from '../../admission/principal'
import { WorkspaceCredentials } from '../../admission/workspace-credentials'
import { ticketForGrant, type HttpServerOptions } from '../http'

/** Shares token admission with socket connections. The ticket is consumed in-process; no socket is opened. */
export function workspaceCredentialsForHttp(options: HttpServerOptions): WorkspaceCredentials {
  const serviceId = options.solusApi?.serviceId ?? getInstallationId()
  return new WorkspaceCredentials({
    audience: serviceId, secret: options.solusApi?.signingKey,
    authenticateSource: async (bearer, shareSecret) => {
      if (!options.pairingDisabled && !options.isApiMode) {
        const paired = verifySessionToken(bearer)
        if (paired) return { principal: { kind: 'local-owner', deviceId: paired.deviceId, deviceLabel: paired.deviceLabel }, expiresAt: paired.issuedAt + SESSION_TOKEN_TTL_MS }
      }
      const verdict = await options.verifyAccessToken?.(bearer)
      if (!verdict?.ok) return null
      // A host's delegated token (plans/010-standard-oauth.md) stands for its person, in
      // the organization it names; the credential records which host acts for them.
      const { act, ...person } = verdict.claims
      if (act && !options.isApiMode) return null
      const admitted = await ticketForGrant(person, { shareSecret }, options.resolveShareSecret, { workspace: options.isApiMode })
      if (!admitted.ok) return null
      // A person's token opens that person's own connections here.
      rememberPersonToken(bearer, verdict.claims)
      const ticket = consumeWsTicket(admitted.ticket)
      if (!ticket) return null
      const principal = principalFor({ kind: 'ticket', ticket })
      if (!act) return { principal, expiresAt: verdict.claims.exp * 1000 }
      return principal.kind === 'org-member' ? { principal, expiresAt: verdict.claims.exp * 1000, delegation: { hostId: act.host_id } } : null
    },
    isRevoked: async principal => principal.kind !== 'system' && !!principal.deviceId && isDeviceRevoked(principal.deviceId),
    homeFor: principal => {
      if (options.isApiMode) {
        return (principal.kind === 'org-member' || principal.kind === 'guest') && principal.organizationId
          ? { kind: 'organization', serviceId, organizationId: principal.organizationId } : null
      }
      return principal.kind === 'local-owner' || principal.kind === 'remote-owner' || principal.kind === 'org-member'
        ? { kind: 'local', hostId: serviceId } : null
    },
  })
}
