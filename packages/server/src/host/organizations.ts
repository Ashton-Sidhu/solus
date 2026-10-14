import {
  DEFAULT_ORGANIZATION_POLICY,
  hostOrganizationsResponseSchema,
  type HostCategory,
  type HostOrganization,
  type HostOrganizationsResponse,
  type HostOwnerIdentity,
  type OrganizationPolicy,
  type HostRegistration,
} from '@solus/contracts/uplink'
import { createLogger } from '../logger'
import type { FetchLike } from '../admission/access-tokens'
import { HostCredentialError, type HostCredential } from './host-credential'
import { hostCategory } from './host-category'
import { LOCAL_ORGANIZATION_ID } from './host-category'

const log = createLogger('main', 'host-organizations')

/**
 * What the control plane knows about this host's standing (organization-scope
 * §3, §3.1, §6.1): the account it is registered to, and every organization it may
 * deliver records to, each with the policy its owners set. Read from
 * `GET /v1/hosts/:id/organizations` under the host's control token when the host
 * registers, on demand, and every few minutes, so a policy change reaches the host
 * without a restart. An unregistered host stands in no organization. The link plays
 * no part (docs/adr/0001-standard-authentication.md §2.2 rule 9).
 *
 * The registry is the one place the host holds a policy against: the runner
 * delivery asks it which organizations sync Insights, the admission asks it
 * whether an organization allows this personal host to run its work, and the
 * clients read it to show the effective state.
 */

export interface HostStanding {
  hostId: string
  category: HostCategory
  owner: HostOwnerIdentity | null
  organizations: HostOrganization[]
  /** When the control plane last answered (epoch ms). */
  refreshedAt: number
}

export interface HostOrganizationsDeps {
  registration: () => HostRegistration | null
  /** The host credential of the current registration; its control token authenticates the read. */
  credential: () => Pick<HostCredential, 'hostAccessToken'> | null
  /** The account plane answered that this is not the host's current registration: the registrar checks it, and forgets one Solus cloud refused. */
  onRegistrationRefused?: () => void
  fetchImpl?: FetchLike
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/** A key the account plane refused reads as no token: the registration is gone. Anything else is an outage. */
function refusedAsNull(error: Error): null {
  if (error instanceof HostCredentialError && error.code === 'refused') return null
  throw error
}

const REFRESH_MS = 5 * 60_000
const RETRY_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

export class HostOrganizations {
  private standing: HostStanding | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private stopped = false
  private readonly listeners = new Set<(standing: HostStanding | null) => void>()

  constructor(private readonly deps: HostOrganizationsDeps) {}

  current(): HostStanding | null {
    return this.standing
  }

  /** The organizations this host may deliver to; none while unregistered or before the first answer. */
  organizations(): HostOrganization[] {
    return this.standing?.organizations ?? []
  }

  organization(organizationId: string): HostOrganization | null {
    return this.organizations().find((entry) => entry.organizationId === organizationId) ?? null
  }

  /** The policy of one organization; the defaults for one the host has not heard of. `local` has none. */
  policyFor(organizationId: string): OrganizationPolicy | null {
    if (organizationId === LOCAL_ORGANIZATION_ID) return null
    return this.organization(organizationId)?.policy ?? DEFAULT_ORGANIZATION_POLICY
  }

  /** Whether this machine may run `organizationId`'s work under its policy (§3.1). A self-hosted server or a managed machine always may. */
  mayExecute(organizationId: string): boolean {
    if (organizationId === LOCAL_ORGANIZATION_ID) return true
    if (hostCategory() !== 'personal') return true
    return this.policyFor(organizationId)?.allowsPersonalHosts !== false
  }

  /** The account this host is registered to, as the control plane knows it. */
  owner(): HostOwnerIdentity | null {
    return this.standing?.owner ?? null
  }

  onChanged(listener: (standing: HostStanding | null) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    this.stopped = false
    void this.refresh()
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  /** The registration was made, removed, or superseded: forget the standing and ask again. */
  registrationChanged(): void {
    this.setStanding(null)
    if (!this.stopped) void this.refresh()
  }

  /** Ask the control plane now. Resolves when the answer is in (or the attempt failed and a retry is scheduled). */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.refreshNow().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async refreshNow(): Promise<void> {
    this.clearTimer()
    const registration = this.deps.registration()
    const credential = registration ? this.deps.credential() : null
    if (!registration || !credential) {
      this.setStanding(null)
      return
    }
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    let answer: HostOrganizationsResponse | null = null
    try {
      const token = await credential.hostAccessToken().catch(refusedAsNull)
      if (!token) {
        // The account plane no longer knows this host's key: the registration is gone or superseded.
        log.info('host_organizations_unregistered', { status: 'key_refused' })
        this.setStanding(null)
        this.deps.onRegistrationRefused?.()
        return
      }
      const response = await fetchImpl(`${registration.directoryUrl}/v1/hosts/${registration.hostId}/organizations`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.ok) {
        const parsed = hostOrganizationsResponseSchema.safeParse(await response.json().catch(() => null))
        if (parsed.success) answer = parsed.data
        else log.warn('host_organizations_unreadable', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) })
      } else if (response.status === 401 || response.status === 404) {
        // The control token is not of this host's current registration: it is gone or superseded. Nothing to deliver to.
        log.info('host_organizations_unregistered', { status: response.status })
        this.setStanding(null)
        this.deps.onRegistrationRefused?.()
        return
      } else {
        log.warn('host_organizations_refused', { status: response.status })
      }
    } catch (error) {
      log.warn('host_organizations_unreachable', { error: error instanceof Error ? error.message : String(error) })
    }
    if (answer) {
      this.setStanding({ ...answer, refreshedAt: Date.now() })
      this.schedule(REFRESH_MS)
    } else {
      this.schedule(RETRY_MS)
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout
    this.timer = setTimeoutFn(() => { this.timer = null; void this.refresh() }, delayMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(this.timer)
    this.timer = null
  }

  private setStanding(next: HostStanding | null): void {
    const before = JSON.stringify(this.standing && { ...this.standing, refreshedAt: 0 })
    const after = JSON.stringify(next && { ...next, refreshedAt: 0 })
    this.standing = next
    if (before === after) return
    log.info('host_organizations_changed', { organizations: next?.organizations.map((entry) => entry.organizationId) ?? [], category: next?.category ?? null })
    for (const listener of this.listeners) {
      try { listener(next) } catch (error) {
        log.warn('host_organizations_listener_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
