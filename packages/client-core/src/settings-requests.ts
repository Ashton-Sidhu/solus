import {
  ACCOUNT_SETTINGS_PATH,
  accountSettingsConflictBodySchema,
  accountSettingsResponseSchema,
  organizationSettingsConflictBodySchema,
  organizationSettingsPath,
  organizationSettingsResponseSchema,
  type AccountSettingsPatchRequest,
  type AccountSettingsResponse,
  type OrganizationSettingsPatchRequest,
} from '@solus/contracts/settings'
import type { AccountSettingsResult, NativeSolusAPI, OrganizationSettingsResult, SettingsRequestFailure } from '@solus/contracts/host-api'
import { uplinkErrorBodySchema } from '@solus/contracts/uplink'
import type { z } from 'zod'
import type { OAuthSession } from './oauth-session'

export type { AccountSettingsResult, OrganizationSettingsResult, SettingsRequestFailure }

/**
 * The account-plane settings calls (plans/018 §4), one typed method each. Every
 * client owns its credential differently — the web client its page's sign-in,
 * desktop main a bearer token it never gives the renderer, the native app a bearer
 * token in the keychain — so each has an adapter. All of them decode with the
 * contract schemas here, so a status means the same thing on every client.
 */

/**
 * The five calls. The desktop preload bridge (`localApi` on desktop) has exactly
 * these methods; `accountSettingsDelete` clears the synced document and advances
 * its generation.
 */
export type SettingsCloudRequests = Pick<NativeSolusAPI,
  | 'accountSettingsGet'
  | 'accountSettingsPatch'
  | 'accountSettingsDelete'
  | 'organizationSettingsGet'
  | 'organizationSettingsPatch'>

/** One request as an adapter sends it. The path is always one of the settings paths. */
export interface SettingsHttpRequest {
  method: 'GET' | 'PATCH' | 'DELETE'
  path: string
  body?: AccountSettingsPatchRequest | OrganizationSettingsPatchRequest
}

/**
 * Builds the five calls over one authenticated `send`. `send` returns null when the
 * website did not answer and 'signed-out' when there is no session to send with.
 */
export function settingsCloudRequests(
  send: (request: SettingsHttpRequest) => Promise<Response | null | 'signed-out'>,
  takeStartupSettings?: () => Promise<AccountSettingsResponse | null>,
): SettingsCloudRequests {
  const account = async (request: SettingsHttpRequest): Promise<AccountSettingsResult> => {
    const response = await send(request)
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    const result = await accountSettingsResult(response)
    // A clear may answer without a body; the document it left is one read away.
    if (request.method === 'DELETE' && result.kind === 'error' && result.code === 'invalid_response' && response.ok) {
      return account({ method: 'GET', path: ACCOUNT_SETTINGS_PATH })
    }
    return result
  }
  const organization = async (request: SettingsHttpRequest): Promise<OrganizationSettingsResult> => {
    const response = await send(request)
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    return organizationSettingsResult(response)
  }
  return {
    accountSettingsGet: async () => {
      try {
        const startup = await takeStartupSettings?.()
        if (startup) return { kind: 'ok', settings: startup }
      } catch {
        return { kind: 'error', code: 'invalid_response', message: null }
      }
      return account({ method: 'GET', path: ACCOUNT_SETTINGS_PATH })
    },
    accountSettingsPatch: async (body) => {
      await takeStartupSettings?.().catch(() => null)
      return account({ method: 'PATCH', path: ACCOUNT_SETTINGS_PATH, body })
    },
    accountSettingsDelete: async () => {
      await takeStartupSettings?.().catch(() => null)
      return account({ method: 'DELETE', path: ACCOUNT_SETTINGS_PATH })
    },
    organizationSettingsGet: (organizationId) => organization({ method: 'GET', path: organizationSettingsPath(organizationId) }),
    organizationSettingsPatch: (organizationId, body) => organization({ method: 'PATCH', path: organizationSettingsPath(organizationId), body }),
  }
}

export async function accountSettingsResult(response: Response): Promise<AccountSettingsResult> {
  const body: unknown = await response.json().catch(() => null)
  if (response.status === 401) return { kind: 'signed-out' }
  if (response.status === 409) {
    const conflict = accountSettingsConflictBodySchema.safeParse(body)
    return conflict.success
      ? { kind: 'conflict', reason: conflict.data.error, current: conflict.data.current }
      : refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  }
  if (!response.ok) return refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  const parsed = accountSettingsResponseSchema.safeParse(body)
  return parsed.success ? { kind: 'ok', settings: parsed.data } : { kind: 'error', code: 'invalid_response', message: null }
}

export async function organizationSettingsResult(response: Response): Promise<OrganizationSettingsResult> {
  const body: unknown = await response.json().catch(() => null)
  if (response.status === 401) return { kind: 'signed-out' }
  if (response.status === 403 || response.status === 404) return { kind: 'forbidden' }
  if (response.status === 409) {
    const conflict = organizationSettingsConflictBodySchema.safeParse(body)
    return conflict.success ? { kind: 'conflict', current: conflict.data.current } : refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  }
  if (!response.ok) return refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  const parsed = organizationSettingsResponseSchema.safeParse(body)
  return parsed.success ? { kind: 'ok', settings: parsed.data } : { kind: 'error', code: 'invalid_response', message: null }
}

function refusal(status: number, parsed: z.ZodSafeParseResult<z.infer<typeof uplinkErrorBodySchema>>): SettingsRequestFailure {
  return parsed.success
    ? { kind: 'error', code: parsed.data.error, message: parsed.data.message ?? null }
    : { kind: 'error', code: `http_${status}`, message: null }
}

/**
 * The web client served at the account origin: the page's sign-in gives an
 * account-plane access token for each call (docs/adr/0001-standard-authentication.md
 * §2.2); the website's cookie is not sent.
 */
export function webSettingsRequests(origin: string, session: Pick<OAuthSession, 'accessToken' | 'takeStartupSettings'>, fetchImpl: typeof fetch = fetch): SettingsCloudRequests {
  return settingsCloudRequests(async (request) => {
    const token = await session.accessToken({ kind: 'account' })
    if (!token) return 'signed-out'
    const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}` })
    if (request.body) headers.set('content-type', 'application/json')
    try {
      return await fetchImpl(`${origin}${request.path}`, {
        method: request.method,
        credentials: 'omit',
        cache: 'no-store',
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return null
    }
  }, () => session.takeStartupSettings())
}
