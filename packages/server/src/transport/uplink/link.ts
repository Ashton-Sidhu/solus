import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import {
  hostTunnelSchema,
  linkHostResponseSchema,
  uplinkDesiredStateSchema,
  uplinkErrorBodySchema,
  type HostLinkEnv,
  type HostLinkResponse,
  type HostLinkStatus,
  type HostRegistration,
  type HostTunnel,
  type LinkHostRequest,
  type UplinkLinkState,
  type UplinkObservedState,
} from '@solus/contracts/uplink'
import { createLogger } from '../../logger'
import { dataDir, solusDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'
import type { FetchLike } from '../../admission/access-tokens'
import { HostRegistrationError, storeRegistrationRecord } from '../../host/host-registration'
import type { ConnectorObservation } from './connector'

const log = createLogger('main', 'uplink-link')

/**
 * The host's link (docs/adr/0001-standard-authentication.md §2.2 rule 9): it exposes a
 * registered host to the internet through cloudflared, and does nothing else. Linking
 * provisions the tunnel and starts the connector; unlinking stops the connector and
 * removes the tunnel. Nothing depends on the link: the host's identity, key,
 * delegations, account reads, organizations, and directory entry belong to its
 * registration (`host/host-registration.ts`), and the link calls the control plane
 * with the registration's control token.
 *
 * Durable state is the non-secret link record with the *desired* state in
 * `SOLUS_DATA_DIR/host-link.json`, and one secret: the tunnel's connector token.
 * Every transition writes desired state first and then acts, so a crash between the
 * two resumes correctly at boot: an unlink that did not reach the control plane is
 * retried, and a link that is desired starts its connector.
 */

const LINK_FILE = 'host-link.json'
/** Before rule 9, one record held the registration and the link. */
const LEGACY_LINK_FILE = 'uplink-link.json'
const TOKENS_KEY = 'uplink-tokens'
const REQUEST_TIMEOUT_MS = 10_000

const persistedLinkSchema = z.object({
  version: z.literal(2),
  /** The registered host this tunnel is for; a different registration drops it. */
  hostId: z.string().min(1),
  desired: uplinkDesiredStateSchema,
  tunnel: hostTunnelSchema,
}).strict()
/** The tunnel's connector token: infrastructure, not identity. Absent for a directly reached link (a managed host). */
const tokensSchema = z.object({
  connectorToken: z.string().min(1).optional(),
})

type PersistedLink = z.infer<typeof persistedLinkSchema>
type UplinkTokens = z.infer<typeof tokensSchema>

export interface UplinkConnectorHandle {
  start(token: string): void
  stop(): Promise<void>
}

export interface UplinkLinkDeps {
  /** The host's registration; a host links only once it is registered. */
  registration: () => HostRegistration | null
  /** The host's control token, from its registration. */
  controlToken: () => Promise<string>
  /** The loopback port the proxied listener is bound to; 0 when it failed to bind. */
  proxiedPort: () => number
  connector: UplinkConnectorHandle
  /** What `status()` now answers, after every link, unlink, or connector observation. */
  onStatusChanged?: () => void
  fetchImpl?: FetchLike
  /** A provisioned machine (managed-hosts.md §2): the link the control plane put in the environment; null on a machine a person links. */
  provisionedLink?: () => HostLinkEnv | null
}

export class UplinkLinkError extends Error {
  constructor(readonly code: 'not-registered' | 'not-linked' | 'link-rejected' | 'control-plane-unreachable', message: string) {
    super(message)
    this.name = 'UplinkLinkError'
  }
}

export class UplinkLinkManager {
  private persisted: PersistedLink | null
  private observed: UplinkObservedState = 'offline'
  private observedError: string | undefined

  constructor(private readonly deps: UplinkLinkDeps) {
    this.persisted = readPersistedLink()
  }

  /** The tunnel of the current link; null while the host is not linked. */
  currentTunnel(): HostTunnel | null {
    return this.persisted?.desired === 'linked' ? this.persisted.tunnel : null
  }

  status(): HostLinkStatus {
    const tunnel = this.currentTunnel()
    if (!tunnel) return this.observedError && !this.persisted ? { linked: false, error: this.observedError } : { linked: false }
    const state: UplinkLinkState = this.observedError
      ? { observed: this.observed, error: this.observedError }
      : { observed: this.observed }
    return { linked: true, tunnel, state }
  }

  /** Turns the tunnel on: Solus cloud provisions it, and the connector starts. Nothing else changes. */
  async link(): Promise<HostLinkStatus> {
    const registration = this.deps.registration()
    if (!registration) throw new UplinkLinkError('not-registered', 'Sign in to your Solus account on this host first, so it is registered.')
    if (this.persisted?.desired === 'linked') return this.status()
    if (this.persisted) {
      // An unlink the control plane has not confirmed yet: finish it first.
      await this.completeUnlink()
      if (this.persisted) throw new UplinkLinkError('control-plane-unreachable', 'The previous link is still being removed. Try again in a moment.')
    }
    if (!this.deps.proxiedPort()) {
      throw new UplinkLinkError('link-rejected', 'The tunnel listener is not running on this host; restart Solus and try again.')
    }
    const body: LinkHostRequest = { proxiedPort: this.deps.proxiedPort() }
    const response = await this.request(`${registration.directoryUrl}/v1/hosts/${registration.hostId}/link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.controlToken()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
      throw new UplinkLinkError('link-rejected', linkRejectionMessage(response.status, detail.data?.error, detail.data?.message))
    }
    const linked = linkHostResponseSchema.parse(await response.json())
    this.storeLink(registration.hostId, linked.tunnel, linked.connectorToken)
    return this.status()
  }

  /** Turns the tunnel off: the connector stops and Solus cloud removes the tunnel. The registration stays. */
  async unlink(): Promise<HostLinkStatus> {
    if (!this.persisted) throw new UplinkLinkError('not-linked', 'This host is not linked.')
    this.setPersisted({ ...this.persisted, desired: 'unlinked' })
    await this.deps.connector.stop()
    await this.completeUnlink()
    return this.status()
  }

  /**
   * Boot, after the registration's check (`HostRegistrar.resume`), with what Solus cloud
   * said about the host: finish an interrupted unlink, adopt a provisioned machine's
   * link, or start the connector of a link Solus cloud still has. Runs again when a boot
   * check Solus cloud did not answer is answered later (`isRetrying`).
   */
  async resume(remote: HostLinkResponse | null, isRetrying = false): Promise<void> {
    try {
      await this.resumeLink(remote)
    } catch (err) {
      log.warn('uplink_resume_failed', { error: err instanceof Error ? err.message : String(err) })
      const error = isRetrying
        ? 'The tunnel could not start. Solus tries again when it reaches Solus cloud.'
        : 'The tunnel could not start. Restart Solus to try again.'
      this.setObservation({ observed: 'error', error })
    }
  }

  private async resumeLink(remote: HostLinkResponse | null): Promise<void> {
    const registration = this.deps.registration()
    // A provisioned machine is reached at the address its environment names: no tunnel, no connector.
    const env = this.deps.provisionedLink?.()
    if (env && registration?.hostId === env.registration.hostId) {
      if (this.persisted?.desired !== 'linked' || this.persisted.hostId !== registration.hostId || JSON.stringify(this.persisted.tunnel) !== JSON.stringify(env.tunnel)) {
        this.storeLink(registration.hostId, env.tunnel, undefined)
      } else {
        this.startReach(undefined)
      }
      return
    }
    if (!this.persisted) return
    if (this.persisted.desired === 'unlinked') {
      await this.completeUnlink()
      return
    }
    if (!registration || registration.hostId !== this.persisted.hostId) {
      // The registration this tunnel was for is gone: nothing can serve it.
      this.forgetLink('uplink_link_dropped_with_registration')
      return
    }
    if (remote && remote.desired !== 'linked') {
      // Solus cloud no longer has this link (the host was unlinked or deleted elsewhere).
      // A boot check answered late finds the connector started from the stored token.
      await this.deps.connector.stop()
      this.forgetLink('uplink_link_ended_elsewhere')
      return
    }
    const connectorToken = this.loadTokens()?.connectorToken
    if (!connectorToken) {
      this.setObservation({ observed: 'error', error: 'The tunnel credential is missing; turn the link off and on again.' })
      return
    }
    const { proxiedPort } = this.persisted.tunnel
    if (this.deps.proxiedPort() !== proxiedPort) {
      // The tunnel's ingress points at a port this host could not bind. Running the
      // connector would only make every request 502; say so instead.
      this.setObservation({ observed: 'error', error: `Port ${proxiedPort} is in use on this host, so the tunnel cannot reach it. Free the port and restart Solus, or turn the link off and on again.` })
      return
    }
    this.startReach(connectorToken)
  }

  /** The registration changed: a tunnel of another registration, or of none, is dropped here. */
  registrationChanged(registration: HostRegistration | null): void {
    if (!this.persisted || this.persisted.hostId === registration?.hostId) return
    void this.deps.connector.stop()
    this.forgetLink('uplink_link_dropped_with_registration')
  }

  handleConnectorObservation(observation: ConnectorObservation): void {
    this.setObservation(observation)
  }

  /**
   * The tunnel's connector when the link has one. Without one the host is reached
   * directly — its platform proxy forwards to the proxied listener — so there is
   * nothing to run and nothing to observe: a current link is online.
   */
  private startReach(connectorToken: string | undefined): void {
    if (connectorToken) this.deps.connector.start(connectorToken)
    else this.setObservation({ observed: 'online' })
  }

  private storeLink(hostId: string, tunnel: HostTunnel, connectorToken: string | undefined): void {
    secretStore().saveJson(TOKENS_KEY, tokensElectronPath(), { connectorToken })
    this.setPersisted({ version: 2, hostId, desired: 'linked', tunnel })
    this.setObservation({ observed: 'offline' })
    this.startReach(connectorToken)
    log.info('uplink_linked', { hostId, hostname: tunnel.hostname })
  }

  private async completeUnlink(): Promise<void> {
    const persisted = this.persisted
    if (!persisted) return
    const registration = this.deps.registration()
    if (registration?.hostId === persisted.hostId) {
      let done = false
      try {
        const response = await this.request(`${registration.directoryUrl}/v1/hosts/${registration.hostId}/link`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${await this.controlToken()}` },
        })
        // 401: the registration is gone, and its link with it.
        done = response.status === 204 || response.status === 401 || response.status === 404
        if (!done) log.warn('uplink_unlink_rejected', { status: response.status })
      } catch (err) {
        // A registration Solus cloud refused has no link there either.
        done = err instanceof UplinkLinkError && err.code === 'not-registered'
        if (!done) log.warn('uplink_unlink_deferred', { error: err instanceof Error ? err.message : String(err) })
      }
      if (!done) return
    }
    this.forgetLink('uplink_unlinked')
  }

  private forgetLink(event: 'uplink_unlinked' | 'uplink_link_dropped_with_registration' | 'uplink_link_ended_elsewhere'): void {
    const hostId = this.persisted?.hostId ?? null
    secretStore().remove(TOKENS_KEY, tokensElectronPath())
    this.observedError = undefined
    this.observed = 'offline'
    this.setPersisted(null)
    log.info(event, { hostId })
  }

  private async controlToken(): Promise<string> {
    try {
      return await this.deps.controlToken()
    } catch (error) {
      if (error instanceof HostRegistrationError && error.code === 'not-registered') throw new UplinkLinkError('not-registered', error.message)
      throw new UplinkLinkError('control-plane-unreachable', error instanceof Error ? error.message : String(error))
    }
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch((err) => {
      throw new UplinkLinkError('control-plane-unreachable', `Solus cloud is not reachable: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private loadTokens(): UplinkTokens | null {
    return secretStore().loadJson(TOKENS_KEY, tokensElectronPath(), tokensSchema)
  }

  private setPersisted(next: PersistedLink | null): void {
    this.persisted = next
    writePersistedLink(next)
    this.deps.onStatusChanged?.()
  }

  private setObservation(observation: ConnectorObservation): void {
    this.observed = observation.observed
    this.observedError = observation.observed === 'error' ? observation.error : undefined
    this.deps.onStatusChanged?.()
  }
}

function linkRejectionMessage(status: number, code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'invalid_host_credential': return 'Solus cloud no longer accepts this host’s registration. Sign in again to register it.'
    case 'tunnel_not_configured': return 'Solus cloud is not set up for tunnels yet.'
    case 'tunnel_account_limit': return 'Solus cloud cannot allocate another tunnel right now.'
    case 'tunnel_provisioning_failed': return `Solus cloud could not set up the tunnel${message ? `: ${message}` : ''}.`
    default: return `Solus cloud refused the link (${status}).`
  }
}

/** The tunnel stored on disk, read before the manager exists: the port the tunnel listener binds. */
export function readStoredTunnel(): HostTunnel | null {
  const persisted = readPersistedLink()
  return persisted?.desired === 'linked' ? persisted.tunnel : null
}

/**
 * A host that stored one record for its registration and its link (before rule 9)
 * keeps both: the registration moves to its own record, and a link that was on stays
 * on. Runs once at boot, before the registration and the link are read; the old file
 * is removed. Its key and connector token stay where they are.
 */
export function splitLegacyLinkRecord(): void {
  const file = join(solusDir(), LEGACY_LINK_FILE)
  if (!existsSync(file)) return
  try {
    const legacy = legacyLinkSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (legacy.success && legacy.data.desired === 'linked') {
      const { link, attachedAt } = legacy.data
      storeRegistrationRecord({
        hostId: link.hostId,
        issuer: link.issuer,
        jwksUrl: link.jwksUrl,
        directoryUrl: link.directoryUrl,
        generation: link.connectionGeneration,
        ...(link.organizationId ? { organizationId: link.organizationId } : {}),
        ...(link.apiUrl ? { apiUrl: link.apiUrl } : {}),
      }, attachedAt)
      // A provisioned machine's link is its environment's again at boot; a person's tunnel stays on.
      if (!link.organizationId) {
        writePersistedLink({ version: 2, hostId: link.hostId, desired: 'linked', tunnel: { hostname: link.hostname, proxiedPort: link.proxiedPort } })
      }
      log.info('uplink_legacy_record_split', { hostId: link.hostId })
    }
    unlinkSync(file)
  } catch (err) {
    log.warn('uplink_legacy_record_unreadable', { error: err instanceof Error ? err.message : String(err) })
  }
}

const legacyLinkSchema = z.object({
  version: z.literal(1),
  desired: uplinkDesiredStateSchema,
  link: z.object({
    hostId: z.string().min(1),
    issuer: z.string().min(1),
    jwksUrl: z.string().min(1),
    directoryUrl: z.string().min(1),
    hostname: z.string().min(1),
    proxiedPort: z.number().int().positive(),
    connectionGeneration: z.number().int().nonnegative(),
    organizationId: z.string().min(1).optional(),
    apiUrl: z.string().min(1).optional(),
  }),
  attachedAt: z.number().int().nonnegative().optional(),
})

function linkFile(): string {
  return join(solusDir(), LINK_FILE)
}

function tokensElectronPath(): string {
  return join(dataDir(), 'uplink-tokens.bin')
}

function readPersistedLink(): PersistedLink | null {
  const file = linkFile()
  if (!existsSync(file)) return null
  try {
    const parsed = persistedLinkSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch (err) {
    log.warn('uplink_link_file_unreadable', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function writePersistedLink(value: PersistedLink | null): void {
  const file = linkFile()
  if (!value) {
    if (existsSync(file)) unlinkSync(file)
    return
  }
  const dir = solusDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
}
