import { CLIENT_SOLUS_API_SCOPES, solusApiScopeSchema } from '@solus/contracts/solus-api'
import { getInstallationId, isDeviceRevoked } from '../../admission/auth'
import { principalExpiresAt, type Principal } from '../../admission/principal'
import type { Doors } from '../../admission/doors'
import type { WorkspaceAdmission, WorkspaceRequestContext } from '../../admission/workspace-credentials'
import type { WorkspaceRecordHome } from '@solus/contracts/solus-api'
import type { HttpServerOptions } from '../http'

/**
 * Who a `/v1` request is (docs/plans/simplify-auth-and-sync.md §4.2): over a socket,
 * the socket's principal; over HTTP, the bearer itself, admitted by the same doors as
 * a socket's credential. An API token admits its person with no second credential; a
 * host's delegated token admits the person it acts for, and its agent's writes are the
 * agent's.
 */
export function workspaceAdmissionFor(options: Pick<HttpServerOptions, 'isApiMode' | 'solusApi'>, doors: Doors): WorkspaceAdmission {
  const serviceId = options.solusApi?.serviceId ?? getInstallationId()
  const homeFor = (principal: Principal): WorkspaceRecordHome | null => {
    // Never the host itself or a runner, never a revoked device.
    if (principal.kind === 'system' || principal.kind === 'runner') return null
    if (principal.deviceId && isDeviceRevoked(principal.deviceId)) return null
    if (!options.isApiMode) return { kind: 'local', hostId: serviceId }
    return (principal.kind === 'org-member' || principal.kind === 'guest') && principal.organizationId
      ? { kind: 'organization', serviceId, organizationId: principal.organizationId } : null
  }
  return {
    socket: async (principal) => {
      const expiresAt = principalExpiresAt(principal)
      if (expiresAt !== null && expiresAt <= Date.now()) return null
      const home = homeFor(principal)
      return home ? { principal, home, scopes: [...CLIENT_SOLUS_API_SCOPES] } : null
    },
    bearer: async (bearer, organizationId) => {
      const admission = await doors.admitBearer(bearer, organizationId)
      if (!admission.ok) return null
      const actingHostId = admission.actingHostId
      const home = homeFor(admission.principal)
      if (!home) return null
      if (!actingHostId) return { principal: admission.principal, home, scopes: [...CLIENT_SOLUS_API_SCOPES] }
      // A host's agent acting for the person: its writes are the agent's, in the delegation's organization.
      if (home.kind !== 'organization') return null
      const context: WorkspaceRequestContext = { principal: admission.principal, home, scopes: [...solusApiScopeSchema.options], delegation: { hostId: actingHostId }, actingAgent: { organizationId: home.organizationId } }
      return context
    },
  }
}

/**
 * A person's own access token, as a member of one organization: how a share link's
 * resolve learns whether the visitor opens it as themselves
 * (docs/plans/instant-share-open.md). Null for no token, a host's delegated token, or a
 * person the token does not list in that organization.
 */
export async function organizationMemberFor(doors: Doors, bearer: string, organizationId: string): Promise<Principal | null> {
  const admission = await doors.admitBearer(bearer, organizationId)
  return admission.ok && !admission.actingHostId && admission.principal.kind === 'org-member' && admission.principal.organizationId === organizationId ? admission.principal : null
}
