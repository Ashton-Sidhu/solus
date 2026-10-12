import {
  accountResponseSchema,
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  managedHostStartResponseSchema,
  type AccountResponse,
  type ManagedHostLifecycle,
  type UplinkDirectory,
  type UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import type { z } from 'zod'
import { settingsCloudRequests, type SettingsCloudRequests } from '@solus/client-core/settings-requests'
import { agentProfileCloudRequests, type AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'

/**
 * The Solus account calls the native client makes, each with a five-minute access
 * token for the account plane as the bearer (docs/adr/0001-standard-authentication.md
 * §2.2). Same paths and schemas as the desktop's account session
 * (`apps/desktop/src/main/account/`); a native app shares no cookies with the
 * browser, so nothing here relies on one.
 */

export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

/** The account plane refused the access token: the grant may have ended. */
export class AccountUnauthorizedError extends Error {
  constructor() {
    super('The Solus account refused the access token.')
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

  async account(accessToken: string): Promise<AccountResponse> {
    return parseResponse(accountResponseSchema, await this.call(accessToken, '/v1/account'), 'account')
  }

  async directory(accessToken: string): Promise<UplinkDirectory> {
    const directory = await parseResponse(directoryResponseSchema, await this.call(accessToken, '/v1/hosts'), 'host directory')
    return { directoryUrl: this.origin, ...directory }
  }

  /** Asks Solus Cloud to start a stopped managed host. Callers check
   *  `managedHostNeedsStart` first; the directory then reports `ready`. */
  async startManagedHost(accessToken: string, hostId: string): Promise<ManagedHostLifecycle | null> {
    const response = await this.call(accessToken, `/v1/hosts/${encodeURIComponent(hostId)}/start`, { method: 'POST' })
    return (await parseResponse(managedHostStartResponseSchema, response, 'host start')).lifecycle
  }

  /** A one-use ticket a host redeems with `uplinkLink` to link itself to this account. */
  async enrollmentTicket(accessToken: string): Promise<UplinkEnrollmentTicket> {
    const response = await this.call(accessToken, '/v1/enrollment-tickets', { method: 'POST' })
    return { ...(await parseResponse(enrollmentTicketResponseSchema, response, 'link ticket')), directoryUrl: this.origin }
  }

  /**
   * Settings sync and organization settings (plans/018 §4) with an access token got
   * when each call is made. Answers are decoded in client-core, the same as on desktop
   * and web; `onUnauthorized` hears a 401.
   */
  settingsRequests(accessToken: () => Promise<string | null>, onUnauthorized: () => void): SettingsCloudRequests {
    return settingsCloudRequests((request) => this.accountRequest(request, accessToken, onUnauthorized))
  }

  /** The agent profile document (plans/020-agent-profile.md §3), with the same token. */
  agentProfileRequests(accessToken: () => Promise<string | null>, onUnauthorized: () => void): AgentProfileCloudRequests {
    return agentProfileCloudRequests((request) => this.accountRequest(request, accessToken, onUnauthorized))
  }

  private accountRequest(request: { method: string; path: string; body?: object }, accessToken: () => Promise<string | null>, onUnauthorized: () => void): Promise<Response | null | 'signed-out'> {
    return (async () => {
      const token = await accessToken()
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
      if (response.status === 401) onUnauthorized()
      return response
    })()
  }

  private async call(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        ...init,
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, ...init.headers },
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
