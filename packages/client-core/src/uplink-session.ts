import {
  accountResponseSchema,
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  managedHostRestartResponseSchema,
  managedHostSpecChangeResponseSchema,
  managedHostStartResponseSchema,
  managedHostStopResponseSchema,
  organizationDirectorySchema,
  type AccountResponse,
  type ManagedHostLifecycle,
  type ManagedHostSpecChangeRequest,
  type ManagedHostSpecRequest,
  type OrganizationDirectory,
  type UplinkDirectory,
  type UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import type { ConnectionTokenResource } from '@solus/contracts/auth/clients'
import type { AccountState, CreateManagedHostOutcome } from '@solus/contracts/account-types'
import type { ResourceRefusal } from './oauth-session'
import type { WebTokenSession } from './web-token-session'
import { httpClient, type HttpRequest } from './http-request'
import { createManagedHostBody, createManagedHostOutcome } from './cloud-account'
import type { KnownHostUplink } from './known-host'

/**
 * Personal Uplink from the client's side (docs/plans/personal-uplink.md, C1/C2).
 *
 * Two things a client does on behalf of the signed-in account: read the host
 * directory and get access tokens for one host or the Solus API. Where the account
 * sign-in lives decides how: on desktop the Electron main process holds it and
 * answers over the native bridge; on the cloud-served web client the account origin
 * signs tokens from the website session, and the page's `WebTokenSession` asks it for
 * them (docs/plans/web-session-tokens.md). Neither path hands a refresh token to
 * this module.
 */

export interface UplinkAccountSource {
  /** Null when signed out or the website could not be reached. */
  listDirectory(): Promise<UplinkDirectory | null>
  /** An access token for one host or the Solus API; `refused` names a kept one the resource refused. */
  accessToken(resource: ConnectionTokenResource, options?: { refused?: string }): Promise<string | null>
  /** Why the last `accessToken` for this resource gave none, when the account plane refused it.
   *  Absent where the sign-in lives in another process (desktop). */
  accessTokenRefusal?(resource: ConnectionTokenResource): ResourceRefusal | null
  /** True when the account holds no sign-in: it ended (expired, revoked) or was never made. */
  isSignedOut(): boolean
  issueEnrollmentTicket(): Promise<UplinkEnrollmentTicket | null>
  /** People and teams of one organization, for the share dialog; null when not a member. */
  loadOrganizationDirectory(organizationId: string): Promise<OrganizationDirectory | null>
  /** Ask an organization's managed host to run (docs/plans/project-model.md §6);
   *  the lifecycle it is in afterwards, or null when the call was refused. */
  startManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
  /** Ask a managed host to stop; it keeps its disk. The lifecycle afterwards, or null when refused. */
  stopManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
  /** Restart a running managed host's service. The lifecycle afterwards, or null when refused
   *  (a host not wanted running is refused). */
  restartManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
  /** Change a managed host's packages or setup script (owners only); the size cannot change.
   *  True when something changed (a running host restarts to take it), false when nothing did,
   *  null when refused or unanswered. */
  updateManagedHostSpec(hostId: string, change: ManagedHostSpecChangeRequest): Promise<boolean | null>
  /** Destroy a managed host's machine and end its registration (owners only). A host the
   *  account no longer has is already gone, so this is idempotent. False when refused or unanswered. */
  deleteManagedHost(hostId: string): Promise<boolean>
  /** Create an organization's managed host; its host id, or why Solus Cloud did not. */
  createManagedHost(organizationId: string, options: { label?: string; spec?: ManagedHostSpecRequest }): Promise<CreateManagedHostOutcome>
  /** The signed-in account: its organizations and the managed host size catalog. Null when
   *  signed out or the website did not answer. */
  readAccount(): Promise<AccountResponse | null>
  /** End the registration of a host this account owns, on every device. A host the
   *  account does not list is already removed, so this is idempotent. False when refused or unanswered. */
  removeHost(hostId: string): Promise<boolean>
}

/**
 * The web client served from the account origin: its `WebTokenSession` gives an
 * account-plane access token for each call, and the same origin serves `/v1`. The
 * cookie is not sent to `/v1`: the token is the credential there. Every call names the origin
 * explicitly so a bundle served by a host (which has no `/v1`) never mistakes a 404
 * for an empty directory.
 */
export function webUplinkAccountSource(
  origin: string,
  session: Pick<WebTokenSession, 'accessToken' | 'state'> & Partial<Pick<WebTokenSession, 'refusal'>>,
  fetchImpl: typeof fetch = fetch,
): UplinkAccountSource {
  const cloud = httpClient({ baseUrl: origin, token: (options) => session.accessToken({ kind: 'account' }, options), timeoutMs: 8_000, fetch: fetchImpl })
  const call = async (path: string, init?: HttpRequest): Promise<Response | null> => {
    const result = await cloud.request(path, init)
    return result.kind === 'response' ? result.response : null
  }
  return {
    async listDirectory() {
      const response = await call('/v1/hosts')
      if (!response?.ok) return null
      const parsed = directoryResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? { directoryUrl: origin, ...parsed.data } : null
    },
    accessToken: (resource, options) => session.accessToken(resource, options),
    accessTokenRefusal: (resource) => session.refusal?.(resource) ?? null,
    isSignedOut: () => isSignedOutState(session.state()),
    async issueEnrollmentTicket() {
      const response = await call('/v1/enrollment-tickets', { method: 'POST' })
      if (!response?.ok) return null
      const parsed = enrollmentTicketResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? { ...parsed.data, directoryUrl: origin } : null
    },
    async loadOrganizationDirectory(organizationId) {
      const response = await call(`/v1/orgs/${encodeURIComponent(organizationId)}/directory`)
      if (!response?.ok) return null
      const parsed = organizationDirectorySchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data : null
    },
    async startManagedHost(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/start`, { method: 'POST' })
      if (!response?.ok) return null
      const parsed = managedHostStartResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data.lifecycle : null
    },
    async stopManagedHost(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/stop`, { method: 'POST' })
      if (!response?.ok) return null
      const parsed = managedHostStopResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data.lifecycle : null
    },
    async restartManagedHost(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/restart`, { method: 'POST' })
      if (!response?.ok) return null
      const parsed = managedHostRestartResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data.lifecycle : null
    },
    async updateManagedHostSpec(hostId, change) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/spec`, { method: 'PATCH', body: change })
      if (!response?.ok) return null
      const parsed = managedHostSpecChangeResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data.changed : null
    },
    async deleteManagedHost(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/machine`, { method: 'DELETE' })
      // 404: the account has no such host any more, which is the state asked for.
      return response?.ok === true || response?.status === 404
    },
    async createManagedHost(organizationId, options) {
      return createManagedHostOutcome(await call('/v1/hosts', { method: 'POST', body: createManagedHostBody(organizationId, options) }))
    },
    async readAccount() {
      const response = await call('/v1/account')
      if (!response?.ok) return null
      const parsed = accountResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data : null
    },
    async removeHost(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' })
      // 404: the account does not list it, which is the state asked for.
      return response?.ok === true || response?.status === 404
    },
  }
}

/** An account with no sign-in to give tokens from. A sign-in that runs, or a state not known yet, is not signed out. */
export function isSignedOutState(state: AccountState | undefined): boolean {
  return state?.kind === 'signed-out' || state?.kind === 'invalid' || state?.kind === 'unavailable'
}

/**
 * The organization whose people the share dialog may add. The host's own answer
 * wins; the directory row fills in for the owner, whom the host admits as
 * `local-owner` and so never tells which organization the host is shared with.
 * A host shared with several organizations belongs, for this window, to the one
 * the window works in; with no such selection its first share stands.
 */
export function organizationIdFor(
  hostAnswer: string | null | undefined,
  uplink: KnownHostUplink | undefined,
  activeOrganizationId: string | null = null,
): string | null {
  if (hostAnswer) return hostAnswer
  const shared = uplink?.organizationIds ?? []
  if (activeOrganizationId && shared.includes(activeOrganizationId)) return activeOrganizationId
  return shared[0] ?? null
}
