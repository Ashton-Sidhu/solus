import type { HostGrantClaims, UplinkLinkConfig } from '@solus/contracts/uplink'
import { isManagedHost } from '../server/managed-mode'
import { isWorkspaceMode, workspaceConfig } from '../server/workspace-mode'
import type { Principal } from '../server/principal'

export type IntegrationProvider = 'github' | 'google' | 'atlassian'

interface Executor {
  link: () => UplinkLinkConfig | null
  hostToken: () => string | null
}

let executor: Executor | null = null
const grants = new Map<string, { token: string; expiresAt: number }>()

export function useIntegrationExecutor(source: Executor): void { executor = source }
export function accountConnectionsUrl(): string | null {
  const origin = isWorkspaceMode() ? workspaceConfig().issuer : executor?.link()?.directoryUrl
  return origin ? new URL('/connections', origin).toString() : null
}

/** Called only after the ticket door verified the grant and accepted the user. Kept in server memory, never in a principal/event. */
export function rememberIntegrationGrant(token: string, claims: HostGrantClaims): void {
  const now = Date.now()
  for (const [userId, held] of grants) if (held.expiresAt <= now) grants.delete(userId)
  if (!claims.sub.startsWith('user:') || claims.runner || !['owner', 'org-member'].includes(claims.access ?? '')) return
  grants.set(claims.sub.slice(5), { token, expiresAt: claims.exp * 1000 })
}

/**
 * Whose account connections a call uses; null means the host's own store. The owner
 * of a personal host connects GitHub, Google, and Atlassian on that host, signed in
 * or not. Account connections are for cloud-managed hosts (managed hosts and the
 * workspace service) and for people who do not own the host.
 */
export function integrationUserFor(principal: Principal): string | null {
  switch (principal.kind) {
    case 'local-owner': return null
    case 'remote-owner': return isWorkspaceMode() || isManagedHost() ? principal.userId : null
    case 'org-member': return principal.userId
    case 'guest': return principal.accountUserId ?? principal.share.sharedByUserId
    case 'runner':
    case 'system': return null
  }
}

export async function accountIntegrationCredential(userId: string, provider: IntegrationProvider): Promise<Response | null> {
  const path = `/v1/integrations/${provider}/credential`
  const held = grants.get(userId)
  if (!held || held.expiresAt <= Date.now()) return null
  const link = executor?.link()
  const origin = isWorkspaceMode() ? workspaceConfig().issuer : link?.directoryUrl
  const token = isWorkspaceMode() ? process.env.SOLUS_INTEGRATION_SERVICE_KEY : executor?.hostToken()
  if (!origin || !token) return null
  return fetch(new URL(path, origin), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ userGrant: held.token }), signal: AbortSignal.timeout(15_000), redirect: 'error' })
}

export function resetAccountIntegrationsForTests(): void { executor = null; grants.clear() }
