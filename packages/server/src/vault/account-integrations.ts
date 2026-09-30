import { parseGrantSubject, type AccessTokenClaims, type UplinkLinkConfig } from '@solus/contracts/uplink'
import { isApiMode, apiModeConfig } from '../host/api-mode'

export type IntegrationProvider = 'github' | 'google' | 'atlassian'

interface Executor {
  link: () => UplinkLinkConfig | null
  hostToken: () => string | null
}

let executor: Executor | null = null
/** Each person's latest access token this server admitted, while it is valid. */
const personTokens = new Map<string, { token: string; expiresAt: number }>()
/** A person's delegated access token on this host, for their work after their client closed (plans/010-standard-oauth.md). */
let delegatedToken: ((userId: string) => Promise<string | null>) | null = null

export function useIntegrationExecutor(source: Executor): void { executor = source }
export function useDelegatedTokens(source: ((userId: string) => Promise<string | null>) | null): void { delegatedToken = source }

export function accountConnectionsUrl(): string | null {
  const origin = isApiMode() ? apiModeConfig().issuer : executor?.link()?.directoryUrl
  return origin ? new URL('/connections', origin).toString() : null
}

/**
 * Called only after the ticket door verified the token and accepted the person. Kept in
 * server memory, never in a principal or an event. On a host it is also the subject of
 * the token exchange that lets the host act for the person (sync/delegations.ts).
 */
export function rememberPersonToken(token: string, claims: AccessTokenClaims): void {
  const now = Date.now()
  for (const [userId, held] of personTokens) if (held.expiresAt <= now) personTokens.delete(userId)
  const subject = parseGrantSubject(claims.sub)
  if (subject.kind !== 'user' || !['owner', 'org-member'].includes(claims.access ?? '')) return
  personTokens.set(subject.id, { token, expiresAt: claims.exp * 1000 })
}

/** The access token a person last presented to this server, while it is valid. */
export function heldPersonToken(userId: string): string | null {
  const held = personTokens.get(userId)
  return held && held.expiresAt > Date.now() ? held.token : null
}

export async function accountIntegrationCredential(userId: string, provider: IntegrationProvider): Promise<Response | null> {
  const path = `/v1/integrations/${provider}/credential`
  // The person's own token while they are connected; else this host's delegation for them.
  const accessToken = heldPersonToken(userId) ?? await delegatedToken?.(userId).catch(() => null) ?? null
  if (!accessToken) return null
  const link = executor?.link()
  const origin = isApiMode() ? apiModeConfig().issuer : link?.directoryUrl
  const token = isApiMode() ? process.env.SOLUS_INTEGRATION_SERVICE_KEY : executor?.hostToken()
  if (!origin || !token) return null
  return fetch(new URL(path, origin), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ accessToken }), signal: AbortSignal.timeout(15_000), redirect: 'error' })
}

export function resetAccountIntegrationsForTests(): void { executor = null; personTokens.clear(); delegatedToken = null }
