import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { z } from 'zod'
import {
  hostOrganizationsResponseSchema,
  type HostCategory,
  type HostOrganization,
  type HostOrganizationsResponse,
  type HostOwnerIdentity,
  type HostRegistration,
} from '@solus/contracts/uplink'
import { createLogger } from '../logger'
import type { FetchLike } from '../admission/access-tokens'
import { HostCredentialError, type HostCredential } from './host-credential'

const log = createLogger('main', 'host-organizations')

/**
 * What the control plane knows about this host's standing (organization-scope
 * §3, §3.1, §6.1): the account it is registered to, and every organization it may
 * deliver records to, each with its host rules, its policy, and the host policy it
 * assigned here. Read from `GET /v1/hosts/:id/organizations` under the host's
 * control token when the host registers, on demand, and every minute with an ETag,
 * so a policy change reaches the host within about a minute (plans/030 §5.2). An
 * unregistered host stands in no organization. The link plays no part
 * (docs/adr/0001-standard-authentication.md §2.2 rule 9).
 *
 * The last answer is kept on disk and loaded before the first read, so a host that
 * restarts offline keeps enforcing the policies it last saw. `HostPolicyStore` reads the
 * policies from here; nothing else decodes them.
 */

export interface HostStanding {
  hostId: string
  category: HostCategory
  owner: HostOwnerIdentity | null
  organizations: HostOrganization[]
  /** The webhooks of this host an organization admin paused (docs/plans/webhooks.md §2.7). */
  pausedWebhookIds?: string[]
  /** The organization whose host policy holds `host` on this host (plans/030 §3). */
  hostOwnerOrganizationId: string | null
  /** When the control plane last answered (epoch ms). */
  refreshedAt: number
}

const cachedStandingSchema = z.object({
  etag: z.string().nullable(),
  standing: hostOrganizationsResponseSchema.extend({ refreshedAt: z.number() }),
})

export interface HostOrganizationsDeps {
  registration: () => HostRegistration | null
  /** The host credential of the current registration; its control token authenticates the read. */
  credential: () => Pick<HostCredential, 'hostAccessToken'> | null
  /** The account plane answered that this is not the host's current registration: the registrar checks it, and forgets one Solus cloud refused. */
  onRegistrationRefused?: () => void
  fetchImpl?: FetchLike
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  /** Where the last answer is kept (`<dataDir>/organization-standing.json`); none in tests that do not need it. */
  cachePath?: string
}

/** A key the account plane refused reads as no token: the registration is gone. Anything else is an outage. */
function refusedAsNull(error: Error): null {
  if (error instanceof HostCredentialError && error.code === 'refused') return null
  throw error
}

const REFRESH_MS = 60_000
const RETRY_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

export class HostOrganizations {
  private standing: HostStanding | null = null
  private etag: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private stopped = false
  private readonly listeners = new Set<(standing: HostStanding | null) => void>()
  private readonly refreshedListeners = new Set<() => void>()

  constructor(private readonly deps: HostOrganizationsDeps) {
    this.loadCache()
  }

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

  /** An organization admin paused this webhook (docs/plans/webhooks.md §2.7). */
  isWebhookPausedByAdmin(webhookId: string): boolean {
    return this.pausedWebhookIds().includes(webhookId)
  }

  /** Every webhook of this host an organization admin paused; none before the first answer. */
  pausedWebhookIds(): string[] {
    return this.standing?.pausedWebhookIds ?? []
  }

  /** The account this host is registered to, as the control plane knows it. */
  owner(): HostOwnerIdentity | null {
    return this.standing?.owner ?? null
  }

  /** Hear every answer the control plane gives, changed or not: a retry that waits for the next read. */
  onRefreshed(listener: () => void): () => void {
    this.refreshedListeners.add(listener)
    return () => { this.refreshedListeners.delete(listener) }
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
    this.forget()
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
      this.forget()
      return
    }
    let answer: HostOrganizationsResponse | null = null
    try {
      const token = await credential.hostAccessToken().catch(refusedAsNull)
      if (!token) {
        // The account plane no longer knows this host's key: the registration is gone or superseded.
        log.info('host_organizations_unregistered', { status: 'key_refused' })
        this.forget()
        this.deps.onRegistrationRefused?.()
        return
      }
      const response = await this.requestStanding(registration, token)
      if (response.status === 304 && this.keepUnchanged()) return
      if (response.ok) {
        const parsed = hostOrganizationsResponseSchema.safeParse(await response.json().catch(() => null))
        if (parsed.success) {
          answer = parsed.data
          this.etag = response.headers.get('etag')
        } else log.warn('host_organizations_unreadable', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) })
      } else if (response.status === 401 || response.status === 404) {
        // The control token is not of this host's current registration: it is gone or superseded. Nothing to deliver to.
        log.info('host_organizations_unregistered', { status: response.status })
        this.forget()
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
      this.saveCache()
      for (const listener of this.refreshedListeners) listener()
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

  /** One read of the standing, conditional on the last answer's ETag. */
  private requestStanding(registration: HostRegistration, token: string): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' })
    if (this.etag && this.standing) headers.set('if-none-match', this.etag)
    return (this.deps.fetchImpl ?? fetch)(`${registration.directoryUrl}/v1/hosts/${registration.hostId}/organizations`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  /** A 304: nothing changed since the last answer. False when there is no answer to keep. */
  private keepUnchanged(): boolean {
    if (!this.standing) return false
    this.standing.refreshedAt = Date.now()
    for (const listener of this.refreshedListeners) listener()
    this.schedule(REFRESH_MS)
    return true
  }

  /** The registration is gone: no standing, and no cached copy to load at the next start. */
  private forget(): void {
    this.etag = null
    this.setStanding(null)
    if (this.deps.cachePath) rmSync(this.deps.cachePath, { force: true })
  }

  private loadCache(): void {
    const path = this.deps.cachePath
    if (!path || !existsSync(path)) return
    try {
      const cached = cachedStandingSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      if (!cached.success) {
        log.warn('host_organizations_cache_unreadable', { issues: cached.error.issues.map((issue) => issue.path.join('.')) })
        return
      }
      this.etag = cached.data.etag
      this.standing = cached.data.standing
      log.info('host_organizations_cache_loaded', { organizations: this.standing.organizations.map((entry) => entry.organizationId), refreshedAt: this.standing.refreshedAt })
    } catch (error) {
      log.warn('host_organizations_cache_unreadable', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private saveCache(): void {
    const path = this.deps.cachePath
    if (!path || !this.standing) return
    try {
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify({ etag: this.etag, standing: this.standing }), { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, path)
    } catch (error) {
      log.warn('host_organizations_cache_write_failed', { error: error instanceof Error ? error.message : String(error) })
    }
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
