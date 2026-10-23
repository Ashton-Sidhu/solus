import {
  accountResponseSchema,
  SOLUS_PROTOCOL,
  SOLUS_PROTOCOL_HEADER,
  createManagedHostResponseSchema,
  uplinkErrorBodySchema,
  type AccountResponse,
  type CreateManagedHostRequest,
  type HostShareRequest,
  type ManagedHostSpecRequest,
} from '@solus/contracts/uplink'
import type { SeatProvider } from '@solus/contracts/seats'
import { VAULT_PATH, vaultConnectionListSchema } from '@solus/contracts/vault'
import type { OAuthSession } from './oauth-session'

/**
 * The signed-in Solus Cloud account, as cloud onboarding uses it
 * (docs/plans/cloud-onboarding.md). It exists only on the web client served at the
 * account origin: the page's `OAuthSession` is the credential (an account-plane
 * access token on each call) and the same origin serves `/v1`. The desktop app and a
 * client paired to a machine have none, and so get the host onboarding flow.
 */
/** The part of the page's sign-in that the account uses. */
export type CloudAccountSession = Pick<OAuthSession, 'accessToken' | 'signOut' | 'state' | 'onChange'>

export interface CloudAccount {
  /** The sign-in this account's calls use; its state is who is signed in. */
  readonly session: CloudAccountSession
  /** Null when signed out or the account origin could not be reached. */
  readAccount(): Promise<AccountResponse | null>
  /** The agent seat logins (`seat:*` refs) in the account vault; null means the check failed. */
  readAgentSeats(): Promise<CloudAgentSeat[] | null>
  /**
   * Ends this client grant (revocation), then the website's cookie session: on the
   * account origin the web client and the website are one page, and the cookie would
   * sign the page in again. False when the website did not confirm the cookie's end.
   */
  signOut(): Promise<boolean>
  /** Records that the account finished or skipped onboarding; false when the call failed. */
  completeOnboarding(): Promise<boolean>
  /**
   * Creates the organization's managed host; its host id, or why Solus Cloud did not.
   * The label is the host's friendly name; whatever the spec leaves out is Solus
   * Cloud's default, so no options at all is the generic host.
   */
  createManagedHost(
    organizationId: string,
    options?: { label?: string; spec?: ManagedHostSpecRequest },
  ): Promise<CreateManagedHostOutcome>
  /** Shares a machine the account linked with one organization, or takes that share back (R15). */
  shareHost(hostId: string, organizationId: string, enabled: boolean): Promise<boolean>
  /** The account page where GitHub, Google and Atlassian are connected. */
  readonly connectionsUrl: string
  /** The account website, where the account and its organizations are managed. */
  readonly consoleUrl: string
}

/**
 * A refused create names the `/v1` error code; `code` is null when Solus Cloud did
 * not answer, which does not prove that no host was made.
 */
export type CreateManagedHostOutcome =
  | { ok: true; hostId: string }
  | { ok: false; code: string | null; message: string | null }

/** One agent seat login in the account vault. A seat whose CLI was signed out is not connected. */
export interface CloudAgentSeat {
  provider: SeatProvider
  connected: boolean
  updatedAt: number
}

export function oauthCloudAccount(origin: string, session: CloudAccountSession, fetchImpl: typeof fetch = fetch): CloudAccount {
  const call = async (path: string, init: RequestInit = {}): Promise<Response | null> => {
    const token = await session.accessToken({ kind: 'account' })
    if (!token) return null
    const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}`, [SOLUS_PROTOCOL_HEADER]: String(SOLUS_PROTOCOL) })
    if (init.body) headers.set('content-type', 'application/json')
    try {
      return await fetchImpl(`${origin}${path}`, {
        ...init,
        credentials: 'omit',
        headers,
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return null
    }
  }
  return {
    session,
    connectionsUrl: `${origin}/connections`,
    consoleUrl: origin,
    async readAccount() {
      const response = await call('/v1/account')
      if (!response?.ok) return null
      const parsed = accountResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data : null
    },
    async readAgentSeats() {
      const response = await call(VAULT_PATH, { cache: 'no-store' })
      if (!response?.ok) return null
      const parsed = vaultConnectionListSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) return null
      return parsed.data.connections.flatMap((connection) => connection.ref.kind === 'seat'
        ? [{ provider: connection.ref.provider, connected: connection.status === 'connected', updatedAt: connection.updatedAt }]
        : [])
    },
    async signOut() {
      await session.signOut()
      try {
        const response = await fetchImpl(`${origin}/api/auth/sign-out`, {
          method: 'POST',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(15_000),
        })
        return response.ok
      } catch {
        return false
      }
    },
    async completeOnboarding() {
      const response = await call('/v1/account/onboarding', { method: 'POST' })
      return !!response?.ok
    },
    async createManagedHost(organizationId, options = {}) {
      const { label, spec } = options
      const body: CreateManagedHostRequest = {
        organizationId,
        ...(label ? { label } : {}),
        ...(spec && Object.keys(spec).length > 0 ? { spec } : {}),
      }
      const response = await call('/v1/hosts', { method: 'POST', body: JSON.stringify(body) })
      if (!response) return { ok: false, code: null, message: null }
      const answer = await response.json().catch(() => null)
      if (!response.ok) {
        const refusal = uplinkErrorBodySchema.safeParse(answer)
        return refusal.success
          ? { ok: false, code: refusal.data.error, message: refusal.data.message ?? null }
          : { ok: false, code: `http_${response.status}`, message: null }
      }
      const parsed = createManagedHostResponseSchema.safeParse(answer)
      return parsed.success
        ? { ok: true, hostId: parsed.data.hostId }
        : { ok: false, code: 'invalid_response', message: null }
    },
    async shareHost(hostId, organizationId, enabled) {
      const host = encodeURIComponent(hostId)
      const body: HostShareRequest = { organizationId }
      const response = enabled
        ? await call(`/v1/hosts/${host}/organizations`, { method: 'POST', body: JSON.stringify(body) })
        : await call(`/v1/hosts/${host}/organizations/${encodeURIComponent(organizationId)}`, { method: 'DELETE' })
      return !!response?.ok
    },
  }
}

let configured: CloudAccount | null = null
let startupRead: Promise<AccountResponse | null> | null = null

/**
 * Web boot records the account when the serving origin is the account origin and
 * the page is signed in, and starts reading it at once: whether onboarding is due must be known
 * before the workspace paints, or the draft composer flashes before it.
 */
export function configureCloudAccount(account: CloudAccount | null): void {
  configured = account
  startupRead = account ? account.readAccount() : null
}

/** The account read web boot started; null when there is no cloud account. One answer, shared. */
export function startupAccountRead(): Promise<AccountResponse | null> | null {
  return startupRead
}

export function cloudAccount(): CloudAccount | null {
  return configured
}
