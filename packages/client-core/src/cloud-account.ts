import {
  accountResponseSchema,
  createManagedHostResponseSchema,
  uplinkErrorBodySchema,
  type AccountResponse,
  type CreateManagedHostRequest,
  type ManagedHostSpecRequest,
} from '@solus/contracts/uplink'
import type { AccountProfile } from '@solus/contracts/account-types'
import { z } from 'zod'

/**
 * The signed-in Solus Cloud account, as cloud onboarding uses it
 * (docs/plans/cloud-onboarding.md). It exists only on the web client served at the
 * account origin: the account cookie is the credential and the same origin serves
 * `/v1`. The desktop app and a client paired to a machine have none, and so get the
 * host onboarding flow.
 */
export interface CloudAccount {
  /** Null when signed out or the account origin could not be reached. */
  readAccount(): Promise<AccountResponse | null>
  /** Who the cookie belongs to; null when signed out or the account origin could not be reached. */
  readProfile(): Promise<AccountProfile | null>
  /** Ends the cookie session; false when the account origin did not confirm it. */
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
  /** Shares a machine the account linked with one organization, or takes it back with null. */
  shareHost(hostId: string, organizationId: string | null): Promise<boolean>
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

export function cookieCloudAccount(origin: string, fetchImpl: typeof fetch = fetch): CloudAccount {
  const call = async (path: string, init: RequestInit = {}): Promise<Response | null> => {
    const headers = new Headers({ accept: 'application/json' })
    if (init.body) headers.set('content-type', 'application/json')
    try {
      return await fetchImpl(`${origin}${path}`, {
        ...init,
        credentials: 'same-origin',
        headers,
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return null
    }
  }
  return {
    connectionsUrl: `${origin}/connections`,
    consoleUrl: origin,
    async readAccount() {
      const response = await call('/v1/account')
      if (!response?.ok) return null
      const parsed = accountResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data : null
    },
    async readProfile() {
      const response = await call('/api/account/me')
      return response?.ok ? profileFromResponse(response) : null
    },
    async signOut() {
      const response = await call('/api/auth/sign-out', { method: 'POST' })
      return !!response?.ok
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
    async shareHost(hostId, organizationId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/organization`, {
        method: 'PUT',
        body: JSON.stringify({ organizationId }),
      })
      return !!response?.ok
    },
  }
}

const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
})

/** Parses `GET /api/account/me` at the boundary; anything malformed reads as no profile. */
export async function profileFromResponse(response: Response): Promise<AccountProfile | null> {
  const parsed = meResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return null
  return {
    id: parsed.data.id,
    email: parsed.data.email,
    name: parsed.data.name ?? null,
    avatarUrl: parsed.data.avatarUrl ?? null,
  }
}

let configured: CloudAccount | null = null
let startupRead: Promise<AccountResponse | null> | null = null

/**
 * Web boot records the account when the serving origin is the account origin and
 * signed in, and starts reading it at once: whether onboarding is due must be known
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
