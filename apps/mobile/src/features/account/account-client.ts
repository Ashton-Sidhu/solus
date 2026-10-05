import {
  accountResponseSchema,
  directoryResponseSchema,
  hostAccessTokenResponseSchema,
  managedHostStartResponseSchema,
  type AccountResponse,
  type HostAccessTokenRequest,
  type ManagedHostLifecycle,
  type UplinkDirectory,
} from '@solus/contracts/uplink'
import type { z } from 'zod'
import type { AccountProfile } from '@solus/contracts/account-types'
import { profileFromResponse } from '@solus/client-core/cloud-account'
import { settingsCloudRequests, type SettingsCloudRequests } from '@solus/client-core/settings-requests'

/**
 * The Solus account calls the native client makes, with the account session
 * as a bearer token. Same paths and schemas as the desktop's account session
 * (`apps/desktop/src/main/account/`); a native app shares no cookies with the
 * browser, so nothing here relies on one.
 */

export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

/**
 * The device-authorization client this app signs in as. Solus Cloud must list
 * it in `DEVICE_CLIENTS` (solus-cloud `src/lib/server/auth/device-clients.ts`)
 * before a sign-in can succeed; until then the code request is refused. The
 * desktop's `solus-desktop` id is not reused (plan 017 §7).
 */
export const MOBILE_DEVICE_CLIENT_ID = 'solus-mobile'

/** The account session is no longer accepted: signed out elsewhere or expired. */
export class AccountUnauthorizedError extends Error {
  constructor() {
    super('The Solus account session is no longer valid.')
    this.name = 'AccountUnauthorizedError'
  }
}

/** The account website did not answer or answered with something unreadable. */
export class AccountUnavailableError extends Error {}

export class CloudAccountClient {
  constructor(
    readonly origin: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async me(sessionToken: string): Promise<AccountProfile> {
    const response = await this.call(sessionToken, '/api/account/me')
    const profile = await profileFromResponse(response)
    if (!profile) throw new AccountUnavailableError('The account website answered without a profile.')
    return profile
  }

  async account(sessionToken: string): Promise<AccountResponse> {
    return parseResponse(accountResponseSchema, await this.call(sessionToken, '/v1/account'), 'account')
  }

  async directory(sessionToken: string): Promise<UplinkDirectory> {
    const directory = await parseResponse(directoryResponseSchema, await this.call(sessionToken, '/v1/hosts'), 'host directory')
    return { directoryUrl: this.origin, ...directory }
  }

  /** One ≤5-minute token for one host, naming the organization this device works in. */
  async hostAccessToken(sessionToken: string, hostId: string, organizationId: string | null): Promise<string> {
    const body: HostAccessTokenRequest = organizationId ? { organizationId } : {}
    const response = await this.call(sessionToken, `/v1/hosts/${encodeURIComponent(hostId)}/access-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await parseResponse(hostAccessTokenResponseSchema, response, 'host access')).accessToken
  }

  /** Asks Solus Cloud to start a stopped managed host. Callers check
   *  `managedHostNeedsStart` first; the directory then reports `ready`. */
  async startManagedHost(sessionToken: string, hostId: string): Promise<ManagedHostLifecycle | null> {
    const response = await this.call(sessionToken, `/v1/hosts/${encodeURIComponent(hostId)}/start`, { method: 'POST' })
    return (await parseResponse(managedHostStartResponseSchema, response, 'host start')).lifecycle
  }

  async nameDevice(sessionToken: string, deviceLabel: string): Promise<void> {
    await this.call(sessionToken, '/api/account/device-label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceLabel: deviceLabel.slice(0, 120), clientId: MOBILE_DEVICE_CLIENT_ID }),
    })
  }

  /**
   * Settings sync and organization settings (plans/018 §4) with the session that
   * is current when each call is made. Answers are decoded in client-core, the
   * same as on desktop and web; `onUnauthorized` hears a 401 and the token it refused.
   */
  settingsRequests(sessionToken: () => string | null, onUnauthorized: (sessionToken: string) => void): SettingsCloudRequests {
    return settingsCloudRequests(async (request) => {
      const token = sessionToken()
      if (!token) return 'signed-out'
      const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}` })
      if (request.body) headers.set('content-type', 'application/json')
      let response: Response
      try {
        response = await this.fetchImpl(`${this.origin}${request.path}`, {
          method: request.method,
          headers,
          body: request.body ? JSON.stringify(request.body) : undefined,
          signal: AbortSignal.timeout(15_000),
        })
      } catch {
        return null
      }
      if (response.status === 401) onUnauthorized(token)
      return response
    })
  }

  async signOut(sessionToken: string): Promise<void> {
    await this.call(sessionToken, '/api/auth/sign-out', { method: 'POST' }).catch(() => undefined)
  }

  private async call(sessionToken: string, path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        ...init,
        headers: { accept: 'application/json', authorization: `Bearer ${sessionToken}`, ...init.headers },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new AccountUnavailableError('The account website did not answer.')
    }
    if (response.status === 401) throw new AccountUnauthorizedError()
    if (!response.ok) throw new AccountUnavailableError(`The account website answered ${response.status}.`)
    return response
  }
}

/** Reads a response body through its schema; anything else is the website's fault. */
async function parseResponse<T>(schema: z.ZodType<T>, response: Response, what: string): Promise<T> {
  const parsed = schema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new AccountUnavailableError(`The ${what} response was not understood.`)
  return parsed.data
}
