import {
  DEFAULT_ORGANIZATION_POLICY,
  hostOrganizationsResponseSchema,
  type HostCategory,
  type HostOrganization,
  type HostOrganizationsResponse,
  type HostOwnerIdentity,
  type OrganizationPolicy,
  type UplinkLinkConfig,
} from '@solus/contracts/uplink'
import { createLogger } from '../logger'
import type { FetchLike } from '../admission/access-tokens'
import { hostCategory } from './host-category'
import { LOCAL_ORGANIZATION_ID } from './host-category'

const log = createLogger('main', 'host-organizations')

/**
 * What the control plane knows about this host's standing (organization-scope
 * §3, §3.1, §6.1): the account that linked it, and every organization it may
 * deliver records to, each with the policy its owners set. Read from
 * `GET /v1/hosts/:id/organizations` under the host token when the host links,
 * on demand, and every few minutes, so a policy change reaches the host
 * without a restart. An unlinked host stands in no organization.
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
  link: () => UplinkLinkConfig | null
  hostToken: () => string | null
  fetchImpl?: FetchLike
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
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

  /** The organizations this host may deliver to; none while unlinked or before the first answer. */
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

  /** The account that linked this host, as the control plane knows it. */
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

  /** The link was made, removed, or superseded: forget the standing and ask again. */
  linkChanged(): void {
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
    const link = this.deps.link()
    const hostToken = link ? this.deps.hostToken() : null
    if (!link || !hostToken) {
      this.setStanding(null)
      return
    }
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    let answer: HostOrganizationsResponse | null = null
    try {
      const response = await fetchImpl(`${link.directoryUrl}/v1/hosts/${link.hostId}/organizations`, {
        headers: { authorization: `Bearer ${hostToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.ok) {
        const parsed = hostOrganizationsResponseSchema.safeParse(await response.json().catch(() => null))
        if (parsed.success) answer = parsed.data
        else log.warn('host_organizations_unreadable', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) })
      } else if (response.status === 401 || response.status === 404) {
        // The token is no longer this host's: the link is gone or superseded. Nothing to deliver to.
        log.info('host_organizations_unlinked', { status: response.status })
        this.setStanding(null)
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
